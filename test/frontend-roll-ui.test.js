const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "style.css"), "utf8");
const script = fs.readFileSync(path.join(root, "script.js"), "utf8");

test("Roll page includes responsive and accessible document foundations", () => {
    assert.match(html, /<html lang="en">/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /id="loadingStatus"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /id="result"[^>]*aria-labelledby="artistName"[^>]*tabindex="-1"/);
});

test("external Spotify link is protected and result image starts without false alt text", () => {
    assert.match(html, /id="spotifyLink"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    assert.match(html, /id="artistImage"[^>]*alt=""/);
    assert.match(script, /artistImage\.alt = randomArtist\.name \+ " artist portrait"/);
});

test("recommendation behavior remains exact genre and tier filtering plus Math.random selection", () => {
    assert.match(script, /artist\.genre === selectedGenre && artist\.tier === selectedTier/);
    assert.match(script, /Math\.floor\(Math\.random\(\) \* matchingArtists\.length\)/);
    assert.match(script, /rollAgainButton\.addEventListener\("click"[\s\S]*recordBehavior\("roll_again", currentArtist\)[\s\S]*rollArtist\(\)/);
});

test("empty results are displayed in-page instead of a blocking alert", () => {
    assert.doesNotMatch(script, /alert\s*\(/);
    assert.match(script, /No artists are available for that combination yet/);
});

test("motion respects the operating system accessibility preference", () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("Music Roll uses the reusable blue primary brand token", () => {
    assert.match(css, /--color-primary: #0000FF;/);
    assert.match(css, /\.primary-button[\s\S]*background: var\(--color-primary\)/);
    assert.match(css, /\.result-badge[\s\S]*background: var\(--color-primary\)/);
    assert.match(css, /outline: 3px solid var\(--color-primary\)/);
});

test("header uses a scalable branded dice mark without an external image", () => {
    assert.match(html, /<div class="brand-lockup">/);
    assert.match(html, /<svg class="dice-mark"[^>]*aria-hidden="true"/);
    assert.match(html, /<rect class="dice-face"/);
    assert.equal((html.match(/<circle class="dice-pip"/g) || []).length, 5);
    assert.match(css, /\.dice-face[\s\S]*fill: #FFFFFF/);
    assert.match(css, /\.dice-pip[\s\S]*fill: #000000/);
});

test("My Artists controls expose count, saved state, dialog, and accessible announcements", () => {
    assert.match(html, /id="myArtistsButton"[^>]*aria-haspopup="dialog"/);
    assert.match(html, /id="savedArtistCount">0/);
    assert.match(html, /id="saveArtistButton"[^>]*aria-pressed="false"/);
    assert.match(html, /＋ Add to My Artists/);
    assert.match(html, /<dialog id="myArtistsDialog"[^>]*aria-labelledby="myArtistsHeading"/);
    assert.match(html, /id="collectionAnnouncement"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(script, /No saved artists yet\. Roll for an artist and add one you want to hear again\./);
    assert.match(script, /saveArtistButton\.disabled = !canSave/);
});

test("frontend loads isolated persistence layers before the Roll UI", () => {
    const adapterPosition = html.indexOf('<script src="artist-model-adapter.js">');
    const storePosition = html.indexOf('<script src="my-artists-store.js">');
    const eventsPosition = html.indexOf('<script src="behavior-event-recorder.js">');
    const uiPosition = html.indexOf('<script src="script.js">');
    assert.ok(adapterPosition > 0 && adapterPosition < storePosition);
    assert.ok(storePosition > adapterPosition && storePosition < uiPosition);
    assert.ok(eventsPosition > storePosition && eventsPosition < uiPosition);
    assert.match(script, /function getBrowserStorage\(\)[\s\S]*return window\.localStorage[\s\S]*Browser storage is unavailable/);
    assert.match(script, /MusicRollArtistModel\.adaptArtistDirectory\(artistData\)/);
});

test("passive signals are recorded without inferring Roll Again as a skip", () => {
    assert.match(script, /recordBehavior\("artist_impression", randomArtist\)/);
    assert.match(script, /wasSaved \? "artist_unsaved" : "artist_saved"/);
    assert.match(script, /recordBehavior\("spotify_clicked"/);
    assert.match(script, /recordBehavior\("roll_again"/);
    assert.doesNotMatch(script, /recordBehavior\("artist_skipped"/);
});
