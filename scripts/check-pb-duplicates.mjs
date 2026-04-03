#!/usr/bin/env node
/**
 * check-pb-duplicates.mjs
 *
 * Scans your PocketBase instance for duplicate tracks inside user playlists
 * and public playlists, then optionally removes them.
 *
 * Usage:
 *   node scripts/check-pb-duplicates.mjs [--fix]
 *
 * Required env vars:
 *   PB_URL            PocketBase base URL   (default: http://localhost:8090)
 *   PB_ADMIN_EMAIL    Admin email
 *   PB_ADMIN_PASSWORD Admin password
 *
 * Optional flags:
 *   --fix             Write deduplicated playlists back to PocketBase
 *
 * Example:
 *   PB_URL=https://pb.yourdomain.com \
 *   PB_ADMIN_EMAIL=admin@example.com \
 *   PB_ADMIN_PASSWORD=secret \
 *   node scripts/check-pb-duplicates.mjs --fix
 */

import PocketBase from 'pocketbase';

const PB_URL = process.env.PB_URL ?? 'http://localhost:8090';
const ADMIN_EMAIL = process.env.PB_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.PB_ADMIN_PASSWORD;
const FIX = process.argv.includes('--fix');

// ── helpers ──────────────────────────────────────────────────────────────────

function safeJson(str, fallback) {
    if (!str) return fallback;
    if (typeof str !== 'string') return str;
    try { return JSON.parse(str); } catch { return fallback; }
}

/** Returns { dupes: [{id, title, artist, count}], deduped: Track[] } */
function findDupes(tracks) {
    const seen = new Map(); // id -> first occurrence index
    const dupes = new Map(); // id -> { ...track, count }

    for (const t of tracks) {
        const key = String(t.id ?? '');
        if (!key) continue;
        if (seen.has(key)) {
            if (!dupes.has(key)) {
                dupes.set(key, { ...t, count: 2 });
            } else {
                dupes.get(key).count++;
            }
        } else {
            seen.set(key, t);
        }
    }

    const deduped = tracks.filter((t, i) => {
        const key = String(t.id ?? '');
        if (!key) return true;
        const firstIdx = tracks.findIndex(x => String(x.id) === key);
        return firstIdx === i;
    });

    return { dupes: [...dupes.values()], deduped };
}

function trackLabel(t) {
    const artist = t.artist?.name ?? t.artist ?? '';
    return `${t.title ?? t.id}${artist ? ` — ${artist}` : ''}`;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
        console.error('Error: PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD must be set.');
        process.exit(1);
    }

    const pb = new PocketBase(PB_URL);
    pb.autoCancellation(false);

    console.log(`Connecting to ${PB_URL} …`);
    await pb.admins.authWithPassword(ADMIN_EMAIL, ADMIN_PASSWORD);
    console.log('Authenticated as admin.\n');

    let totalDupeCount = 0;

    // ── 1. DB_users → user_playlists ─────────────────────────────────────────
    console.log('=== Checking DB_users (user playlists) ===\n');

    const users = await pb.collection('DB_users').getFullList({ fields: 'id,username,user_playlists' });
    console.log(`Found ${users.length} user record(s).\n`);

    for (const user of users) {
        const playlists = safeJson(user.user_playlists, {});
        const playlistList = Object.values(playlists);
        if (!playlistList.length) continue;

        const userDupes = [];

        for (const playlist of playlistList) {
            const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
            if (!tracks.length) continue;

            const { dupes, deduped } = findDupes(tracks);
            if (!dupes.length) continue;

            userDupes.push({ playlist, dupes, deduped });
            totalDupeCount += dupes.reduce((s, d) => s + d.count - 1, 0);

            console.log(`  User: ${user.username ?? user.id}`);
            console.log(`  Playlist: "${playlist.name}" (${tracks.length} tracks)`);
            for (const d of dupes) {
                console.log(`    dup x${d.count}  id=${d.id}  "${trackLabel(d)}"`);
            }
            console.log();
        }

        if (FIX && userDupes.length) {
            for (const { playlist, deduped } of userDupes) {
                playlists[playlist.id] = {
                    ...playlist,
                    tracks: deduped,
                    numberOfTracks: deduped.length,
                    updatedAt: Date.now(),
                };
            }
            await pb.collection('DB_users').update(user.id, {
                user_playlists: JSON.stringify(playlists),
            });
            console.log(`  ✓ Fixed ${user.username ?? user.id}\n`);
        }
    }

    // ── 2. public_playlists ───────────────────────────────────────────────────
    console.log('=== Checking public_playlists ===\n');

    let pubPlaylists = [];
    try {
        pubPlaylists = await pb.collection('public_playlists').getFullList({
            fields: 'id,title,name,playlist_name,tracks',
        });
    } catch (e) {
        if (e.status === 404) {
            console.log('public_playlists collection not found — skipping.\n');
        } else {
            throw e;
        }
    }

    console.log(`Found ${pubPlaylists.length} public playlist(s).\n`);

    for (const pl of pubPlaylists) {
        const tracks = safeJson(pl.tracks, []);
        if (!tracks.length) continue;

        const { dupes, deduped } = findDupes(tracks);
        if (!dupes.length) continue;

        const plName = pl.title ?? pl.name ?? pl.playlist_name ?? pl.id;
        totalDupeCount += dupes.reduce((s, d) => s + d.count - 1, 0);

        console.log(`  Playlist: "${plName}" (${tracks.length} tracks)`);
        for (const d of dupes) {
            console.log(`    dup x${d.count}  id=${d.id}  "${trackLabel(d)}"`);
        }
        console.log();

        if (FIX) {
            await pb.collection('public_playlists').update(pl.id, {
                tracks: JSON.stringify(deduped),
            });
            console.log(`  ✓ Fixed "${plName}"\n`);
        }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('─'.repeat(50));
    if (totalDupeCount === 0) {
        console.log('No duplicate tracks found.');
    } else {
        console.log(`Total duplicate track entries found: ${totalDupeCount}`);
        if (!FIX) {
            console.log('\nRun with --fix to remove duplicates.');
        } else {
            console.log('All duplicates removed.');
        }
    }
}

main().catch(err => {
    console.error('Fatal:', err.message ?? err);
    process.exit(1);
});
