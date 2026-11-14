import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs script without types
import { pickRepos, packageName, matchName } from '../../scripts/refresh-packages.mjs';

describe('refresh-packages helpers', () => {
    const repos = ['debian_12', 'debian_13', 'debian_14', 'debian_14', 'debian_13', 'debian_unstable', 'fedora_43', 'fedora_44', 'fedora_rawhide',
        'ubuntu_24_04', 'ubuntu_25_10', 'ubuntu_26_04', 'ubuntu_26_10', 'ubuntu_27_04', 'ubuntu_28_04'];

    it('picks stable releases, skipping testing and unreleased LTS', () => {
        expect(pickRepos(repos, new Date('2026-11-14'))).toEqual({ debian: 'debian_13', fedora: 'fedora_44', ubuntu: 'ubuntu_26_04' });
        expect(pickRepos(repos, new Date('2026-03-01')).ubuntu).toBe('ubuntu_24_04');
        expect(() => pickRepos(['debian_13'])).toThrow();
    });

    it('strips flags from target values', () => {
        expect(packageName('--cask discord')).toBe('discord');
        expect(packageName('code --classic')).toBe('code');
        expect(packageName('btop')).toBe('btop');
    });

    it('only matches names the app already uses', () => {
        expect(matchName(['btop', 'btop-debuginfo'], new Set(['btop']))).toBe('btop');
        expect(matchName(['kdePackages.kate'], new Set(['kate']))).toBe('kdePackages.kate');
        expect(matchName(['kdePackages.kate', 'libsForQt5.kate'], new Set(['kate']))).toBeNull();
        expect(matchName(['something-else'], new Set(['btop']))).toBeNull();
    });
});
