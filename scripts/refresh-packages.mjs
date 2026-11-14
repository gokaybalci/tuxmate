import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// Scheduled package-data refresher (see .github/workflows/refresh-packages.yml).
// Checks every app's package names against Repology, Flathub and the Snap Store,
// fills targets that now exist under a name the app already uses, and writes a
// markdown report of what changed. Dead names are reported, never removed:
// a human decides in the PR.
//
// Usage: node scripts/refresh-packages.mjs [--apps id1,id2]

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPS_DIR = path.join(ROOT, 'src/lib/apps');
const STATUS_FILE = path.join(ROOT, 'scripts/package-status.json');
const AUR_FILE = path.join(ROOT, 'src/lib/aur-packages.json');
const SNAPS_FILE = path.join(ROOT, 'src/lib/verified-snaps.json');
const REPORT_FILE = process.env.REPORT_FILE || path.join(ROOT, 'refresh-report.md');

const UA = 'tuxmate-refresh (+https://github.com/gokaybalci/tuxmate)';
const REPOLOGY_DELAY_MS = 1100; // Repology asks for at most 1 request per second
const AUR_SUFFIXES = ['-bin', '-git', '-appimage'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- pure helpers (tested in src/__tests__/refreshPackages.test.ts) ---

// Repology names repos per release; pick what a typical user runs today.
export function pickRepos(repoNames, today = new Date()) {
    const nums = (re) => [...new Set(repoNames)].map(n => n.match(re)?.[1]).filter(Boolean).map(Number).sort((a, b) => b - a);
    const debian = nums(/^debian_(\d+)$/);
    const fedora = nums(/^fedora_(\d+)$/);
    // Ubuntu LTS = even year .04, only once it has shipped (Repology lists dev releases early)
    const yy = today.getUTCFullYear() % 100;
    const shipped = (v) => v < yy || (v === yy && today.getUTCMonth() >= 4);
    const ubuntu = nums(/^ubuntu_(\d+)_04$/).filter(v => v % 2 === 0 && shipped(v));
    if (debian.length < 2 || !fedora.length || !ubuntu.length) throw new Error('Could not detect current distro releases from Repology');
    return {
        debian: `debian_${debian[1]}`, // the highest number is testing
        fedora: `fedora_${fedora[0]}`,
        ubuntu: `ubuntu_${String(ubuntu[0]).padStart(2, '0')}_04`,
    };
}

// The bare package name inside a target value ("--cask foo" / "foo --classic" -> "foo")
export function packageName(value) {
    return value.replace(/^--cask\s+/, '').split(/\s+/)[0];
}

// Pick a name from a Repology project for a missing target: only one the app already
// uses elsewhere (exact, or as the last segment of a nix attribute path).
export function matchName(candidates, known) {
    const exact = candidates.filter(c => known.has(c));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
    const nested = [...new Set(candidates.filter(c => c.includes('.') && known.has(c.split('.').pop())))];
    return nested.length === 1 ? nested[0] : null;
}

// --- network ---

async function request(url, init = {}, tries = 4) {
    for (let i = 1; ; i++) {
        try {
            const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, ...init.headers }, signal: AbortSignal.timeout(20_000) });
            if (res.status < 500 && res.status !== 429) return res;
            throw new Error(`HTTP ${res.status}`);
        } catch (e) {
            if (i >= tries) throw e;
            await sleep(3000 * i);
        }
    }
}

let lastRepology = 0;
async function repology(url, init) {
    const wait = lastRepology + REPOLOGY_DELAY_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRepology = Date.now();
    return request(url, init);
}

// Returns the Repology project name, false if the repo has no such package, null if unknown.
async function repologyLookup(repo, nameType, name) {
    try {
        const url = `https://repology.org/tools/project-by?repo=${repo}&name_type=${nameType}&target_page=api_v1_project&name=${encodeURIComponent(name)}`;
        const res = await repology(url, { redirect: 'manual' });
        if (res.status === 404) return false;
        const loc = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && loc) return decodeURIComponent(loc.split('/').pop());
        throw new Error(`unexpected HTTP ${res.status}`);
    } catch (e) {
        console.warn(`  ? ${repo} ${name}: ${e.message}`);
        return null;
    }
}

async function flathubHas(id) {
    try {
        const res = await request(`https://flathub.org/api/v2/appstream/${encodeURIComponent(id)}`);
        if (res.status === 404) return false;
        if (res.ok) return true;
        throw new Error(`HTTP ${res.status}`);
    } catch (e) {
        console.warn(`  ? flathub ${id}: ${e.message}`);
        return null;
    }
}

// Returns { found, verified } or null if unknown.
async function snapInfo(name) {
    try {
        const res = await request(`https://api.snapcraft.io/v2/snaps/info/${encodeURIComponent(name)}?fields=publisher`, { headers: { 'Snap-Device-Series': '16' } });
        if (res.status === 404) return { found: false };
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const v = (await res.json()).snap?.publisher?.validation;
        return { found: true, verified: v === 'verified' };
    } catch (e) {
        console.warn(`  ? snap ${name}: ${e.message}`);
        return null;
    }
}

// Nobara ships its own repos (Fedora snapshot, updates, terra, pikaos); same set /etc/yum.repos.d enables
const NOBARA_REPOS = [
    'https://mirrors.nobaraproject.org/rolling/x86_64/nobara',
    'https://mirrors.nobaraproject.org/rolling/x86_64/baseos',
    'https://mirrors.nobaraproject.org/rolling/x86_64/terra',
    'https://rpm.pika-os.com/nobara/media/x86_64/', // a baseurl, not a mirrorlist
];

// Package names plus "provides" names, i.e. everything `dnf install X` accepts by name
export function rpmNames(primaryXml) {
    const names = new Set();
    for (const m of primaryXml.matchAll(/<name>([^<]+)<\/name>|<rpm:provides>([\s\S]*?)<\/rpm:provides>/g)) {
        if (m[1]) names.add(m[1]);
        else for (const e of m[2].matchAll(/name="([^"(/]+)"/g)) names.add(e[1]);
    }
    return names;
}

async function nobaraPackages() {
    const all = new Set();
    for (const repo of NOBARA_REPOS) {
        let base = repo;
        if (!repo.endsWith('/')) {
            const list = await (await request(repo)).text();
            base = list.split('\n').find(l => l.startsWith('http'))?.trim();
            if (!base) throw new Error(`empty mirrorlist ${repo}`);
        }
        base = base.replace(/\/?$/, '/');
        const repomd = await (await request(base + 'repodata/repomd.xml')).text();
        const href = repomd.match(/<data type="primary">[\s\S]*?href="([^"]+)"/)?.[1];
        if (!href) throw new Error(`no primary metadata in ${base}`);
        const buf = Buffer.from(await (await request(base + href)).arrayBuffer());
        const xml = (href.endsWith('.zst') ? zlib.zstdDecompressSync(buf) : href.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString();
        for (const n of rpmNames(xml)) all.add(n);
    }
    return all;
}

// --- main ---

async function main() {
    const only = process.argv.includes('--apps') ? new Set(process.argv[process.argv.indexOf('--apps') + 1].split(',')) : null;

    const statsHtml = await (await repology('https://repology.org/repositories/statistics')).text();
    const repos = pickRepos([...statsHtml.matchAll(/repository\/([a-z0-9_]+)/g)].map(m => m[1]));
    console.log('Repos:', repos);

    const nobara = await nobaraPackages().catch(e => { console.warn('Nobara repos unavailable:', e.message); return null; });
    console.log('Nobara packages:', nobara?.size ?? 'skipped');

    // target -> how to look it up on Repology
    const REPOLOGY = {
        ubuntu: [[repos.ubuntu, 'binname']],
        debian: [[repos.debian, 'binname']],
        fedora: [[repos.fedora, 'binname']],
        opensuse: [['opensuse_tumbleweed', 'binname']],
        nix: [['nix_unstable', 'srcname']],
        arch: [['arch', 'binname'], ['aur', 'srcname']],
        homebrew: [['homebrew', 'srcname'], ['homebrew_casks', 'srcname']],
    };

    const prev = JSON.parse(await fs.readFile(STATUS_FILE, 'utf8').catch(() => '{"missing":{}}'));
    const files = (await fs.readdir(APPS_DIR)).filter(f => f.endsWith('.json')).sort();
    const missing = {}, unknown = [], filled = [];
    const aurOnly = new Set(), archOfficial = new Set(), snapVerified = new Set(), snapUnverified = new Set();
    const catalogFlatpaks = new Set();
    const checkedApps = new Set();

    for (const file of files) {
        const filePath = path.join(APPS_DIR, file);
        const raw = await fs.readFile(filePath, 'utf8');
        const apps = JSON.parse(raw);
        const indent = raw.match(/\n( +)/)?.[1].length ?? 4; // files mix 2 and 4 spaces; keep each one's
        let changed = false;

        for (const app of apps) {
            if (app.targets.flatpak) catalogFlatpaks.add(app.targets.flatpak);
            if (only && !only.has(app.id)) continue;
            checkedApps.add(app.id);
            console.log(`${app.id}`);
            let project = null;

            for (const [target, value] of Object.entries(app.targets)) {
                const name = packageName(value);
                let found = null;

                if (target === 'flatpak') {
                    found = await flathubHas(name);
                } else if (target === 'snap') {
                    const info = await snapInfo(name);
                    found = info && info.found;
                    if (info?.found) (info.verified ? snapVerified : snapUnverified).add(name);
                } else if (REPOLOGY[target]) {
                    // homebrew casks are written "--cask x"; only look in the matching repo
                    const lookups = target === 'homebrew'
                        ? [REPOLOGY.homebrew[value.startsWith('--cask') ? 1 : 0]]
                        : REPOLOGY[target];
                    for (const [repo, type] of lookups) {
                        const p = await repologyLookup(repo, type, name);
                        if (p) {
                            found = true;
                            project ??= p;
                            if (target === 'arch') (repo === 'aur' ? aurOnly : archOfficial).add(name);
                            break;
                        }
                        if (p === null) { found = null; break; }
                        found = false;
                    }
                } else {
                    continue; // npm / script targets are not package-manager packages
                }

                if (found === false) missing[`${app.id}/${target}`] = value;
                if (found === null) unknown.push(`${app.id}/${target}`);
            }

            // Fill targets the app lacks but its Repology project now provides under a known name
            const gaps = Object.keys(REPOLOGY).filter(t => !app.targets[t]);
            if (project && gaps.length) {
                const res = await repology(`https://repology.org/api/v1/project/${encodeURIComponent(project)}`).catch(() => null);
                const entries = res?.ok ? await res.json() : [];
                const known = knownNames(app);
                for (const target of gaps) {
                    for (const [repo, type] of REPOLOGY[target]) {
                        if (repo === 'aur') continue; // AUR fills need a human eye
                        const names = entries.filter(e => e.repo === repo)
                            .flatMap(e => type === 'binname' ? (e.binnames ?? [e.binname]) : [e.srcname]).filter(Boolean);
                        const pick = matchName(names, known);
                        if (!pick) continue;
                        app.targets[target] = repo === 'homebrew_casks' ? `--cask ${pick}` : pick;
                        filled.push(`${app.id}/${target} = \`${app.targets[target]}\``);
                        changed = true;
                        break;
                    }
                }
            }

            // Nobara: the Fedora name is used unless the app sets "nobara"; check it against Nobara's own repos
            const nobaraValue = app.targets.nobara ?? app.targets.fedora;
            if (!nobara) {
                if (nobaraValue) unknown.push(`${app.id}/nobara`);
            } else if (!nobaraValue || !nobara.has(packageName(nobaraValue))) {
                const pick = matchName([...knownNames(app)].filter(n => nobara.has(n)), knownNames(app));
                if (pick) {
                    app.targets.nobara = pick;
                    filled.push(`${app.id}/nobara = \`${pick}\``);
                    changed = true;
                } else if (nobaraValue) {
                    missing[`${app.id}/nobara`] = nobaraValue;
                }
            }
        }

        if (changed) await fs.writeFile(filePath, JSON.stringify(apps, null, indent) + (raw.endsWith('\n') ? '\n' : ''));
    }

    // Keep the AUR and verified-snap lists in step with what we just saw
    const aur = JSON.parse(await fs.readFile(AUR_FILE, 'utf8'));
    aur.packages = [...new Set([...aur.packages.filter(p => !archOfficial.has(p)),
        ...[...aurOnly].filter(p => !AUR_SUFFIXES.some(s => p.endsWith(s)))])];
    await fs.writeFile(AUR_FILE, JSON.stringify(aur, null, 2));

    const snaps = JSON.parse(await fs.readFile(SNAPS_FILE, 'utf8'));
    snaps.apps = [...new Set([...snaps.apps.filter(s => !snapUnverified.has(s)), ...snapVerified])];
    await fs.writeFile(SNAPS_FILE, JSON.stringify(snaps, null, 4));

    // Status: drop old entries for apps checked this run, keep the rest (partial runs)
    const prevMissing = prev.missing || {};
    const unknownSet = new Set(unknown);
    const nextMissing = Object.fromEntries(Object.entries(prevMissing)
        .filter(([k]) => !checkedApps.has(k.split('/')[0]) || unknownSet.has(k)));
    Object.assign(nextMissing, missing);
    await fs.writeFile(STATUS_FILE, JSON.stringify({ checkedAt: new Date().toISOString(), repos, missing: sortObj(nextMissing) }, null, 2) + '\n');

    const newlyMissing = Object.keys(missing).filter(k => !(k in prevMissing));
    const recovered = Object.keys(prevMissing).filter(k => checkedApps.has(k.split('/')[0]) && !(k in missing) && !unknownSet.has(k));

    // New-app ideas: popular Flathub apps not in the catalogue yet
    let ideas = [];
    try {
        const pop = await (await request('https://flathub.org/api/v2/collection/popular?page=1&per_page=60')).json();
        ideas = pop.hits.filter(h => !catalogFlatpaks.has(h.app_id)).slice(0, 15);
    } catch (e) { console.warn('Flathub popular list failed:', e.message); }

    const list = (items) => items.length ? items.map(i => `- ${i}`).join('\n') : '_none_';
    const report = `## Package data refresh

Checked ${checkedApps.size} apps against ${repos.ubuntu}, ${repos.debian}, ${repos.fedora}, Nobara (its own repos), openSUSE Tumbleweed, nixpkgs unstable, Arch/AUR, Homebrew, Flathub and the Snap Store.

### Newly missing (${newlyMissing.length})
The package name was not found any more. Fix or remove the target before merging.
${list(newlyMissing.map(k => `\`${k}\` = \`${missing[k]}\``))}

### Filled in (${filled.length})
Targets that were absent and now exist under a name the app already uses.
${list(filled)}

### Back again (${recovered.length})
${list(recovered.map(k => `\`${k}\``))}

### Could not check (${unknown.length})
Network or API errors; left as they were.
${list(unknown.map(k => `\`${k}\``))}

<details><summary>Still missing from earlier runs (${Object.keys(nextMissing).length - newlyMissing.length})</summary>

Usually third-party repos (the install script adds them) or names Repology does not track.

${list(Object.entries(nextMissing).filter(([k]) => !newlyMissing.includes(k)).map(([k, v]) => `\`${k}\` = \`${v}\``))}
</details>

### Popular on Flathub, not in TuxMate yet
${list(ideas.map(h => `**${h.name}** (\`${h.app_id}\`): ${h.summary}`))}
`;
    await fs.writeFile(REPORT_FILE, report);
    console.log(`\nReport: ${REPORT_FILE}\nnewly missing ${newlyMissing.length}, filled ${filled.length}, unknown ${unknown.length}`);
}

const knownNames = (app) => new Set([app.id, ...Object.entries(app.targets)
    .filter(([t]) => t !== 'npm' && t !== 'script').map(([, v]) => packageName(v))]);
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch(e => { console.error(e); process.exit(1); });
}
