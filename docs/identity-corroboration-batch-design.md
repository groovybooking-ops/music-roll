# Review-only identity corroboration batch design

## Scope and invariants

The cohort is the 40 ineligible records in `artists-46-v2.accounting.preview.json`. Each record enters with its stored Spotify artist ID. The batch never searches Spotify by name, modifies the live directory or registry, calculates confidence, verifies an identity, or migrates an artist.

## Architecture

1. A cohort loader validates the accounting preview and extracts the 40 blocked `{displayName, proposedMusicRollId, spotifyArtistId}` candidates.
2. A cache-first acquisition runner (not yet implemented or approved) resolves exact identifiers through the existing Wikidata, MusicBrainz, and Discogs clients.
3. The pure batch orchestrator in `lib/batch-identity-corroboration.js` compares claims with their source/path provenance, audits MusicBrainz same-name entities separately, classifies evidence, and produces individual reports plus a cohort summary.
4. A future approved runner writes only beneath `data/identity-experiments/curated-40-batch/<run-id>/`; raw cache entries are immutable and reports are review-only.

## Acquisition workflow

For each stored Spotify ID, read the cache or query Wikidata `P1902`. Record zero, one, or multiple returned QIDs and linked `P434` MBIDs/`P1953` Discogs IDs. Follow a unique linked MBID and Discogs ID by exact identifier. Separately search MusicBrainz by the selected record's display name only to enumerate ambiguity; never use that search to select or replace the linked MBID. Fetch bounded competitor details to inspect their Spotify and Discogs URL relationships.

## Persistent cache

Use immutable provider/operation/identifier paths such as `wikidata/spotify-bridge/<spotify-id>.json`, `musicbrainz/artist/<mbid>.json`, `musicbrainz/exact-name/<normalized-name-and-query-hash>.json`, and `discogs/artist/<discogs-id>.json`. Each envelope records schema version, request URL/query hash, retrieval time, HTTP validators when available, response status, attempt history, and raw response. Successful evidence is reused indefinitely unless a future refresh policy is explicitly approved. Negative and transient results have separate status metadata so absence is not confused with a conflict.

## Rate limiting and retries

Run providers through independent serial queues. MusicBrainz starts no faster than one request per 1.1 seconds and honors `Retry-After`; retry 429/503 and transient network failures with capped exponential backoff and jitter. Wikidata and Discogs also honor `Retry-After`, use conservative spacing, and stop retrying permanent 4xx responses. Write each successful response atomically before planning the next request so an interrupted run resumes from cache.

## Outcomes

- `coherent_identity_evidence`: all required exact identifiers agree and the name audit found no competing exact display-name entity.
- `coherent_identity_with_same_name_ambiguity`: exact identifiers agree, while separate MusicBrainz name auditing found competitors.
- `insufficient_corroboration`: some bridge/evidence exists but required linked IDs, exact records, or the ambiguity audit are missing.
- `conflicting_identity`: at least two observed identifier claims disagree.
- `unresolved_identity`: no Wikidata bridge could be established or acquisition failed without enough evidence to classify.

Missing evidence is recorded explicitly and does not create a conflict. Cross-links retain provider, claim path, and origin; repeated links are not collapsed into unnamed independent confirmations.

## Request-volume estimate

The cold cohort requires 40 Wikidata bridge requests. Conditional exact-record requests add at most 40 MusicBrainz and 40 Discogs calls. Same-name auditing adds up to 40 MusicBrainz searches plus a bounded maximum of nine competitor-detail calls per artist. The absolute configured ceiling is therefore 520 calls; because Nirvana's ten raw responses are already cached, a cache-aware first run has a current ceiling of 510. Actual volume should be materially lower when Wikidata lacks linked IDs or exact-name searches return fewer competitors. Warm reruns make zero provider calls unless refresh is explicitly enabled.

## Safety and failure gates

The future runner must default to offline/cache-only mode and require an explicit `--allow-network` flag. It must verify the source accounting checksum and 40-record count, reject duplicate/malformed Spotify IDs, refuse output paths outside the experiment directory, never overwrite raw cache entries, and expose no write path to `data/artists.json` or `data/artist-id-registry.json`. Provider errors are isolated per artist and summarized; malformed, multiple, or conflicting exact-ID responses stop follow-up requests for that artist. Reports always assert `reviewOnly`, `automaticVerificationPerformed: false`, `confidenceScoreCalculated: false`, and `migrationPerformed: false`.
