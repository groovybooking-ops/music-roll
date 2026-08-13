(function(root) {
    "use strict";
    const model = typeof module === "object" && module.exports
        ? require("../../artist-model-adapter.js")
        : root.MusicRollArtistModel;

    function card(artist) {
        return {
            artistName: "🎲 You rolled " + artist.name,
            artistInfo: artist.genre + " • " + artist.tier,
            spotifyHref: artist.spotify,
            imageSrc: artist.image,
            imageDisplay: "inline-block",
            resultHidden: false
        };
    }

    function roll(directory, genre, tier, randomValue) {
        const matches = directory.filter(artist => artist.genre === genre && artist.tier === tier);
        if (!matches.length) return { empty: true, alert: "No artists found for that roll yet 🎲" };
        const selected = matches[Math.floor(randomValue * matches.length)];
        return { empty: false, selected, card: card(selected) };
    }

    function compare(liveRecords, v2Records) {
        const live = model.adaptArtistDirectory(liveRecords);
        const preview = model.adaptArtistDirectory(v2Records);
        const directoriesIdentical = JSON.stringify(live) === JSON.stringify(preview);
        const combinations = [...new Set(live.concat(preview).map(artist => `${artist.genre}\u0000${artist.tier}`))];
        const randomSequence = [0, 0.19, 0.5, 0.81, 0.999999];
        const rolls = combinations.flatMap(key => {
            const [genre, tier] = key.split("\u0000");
            return randomSequence.map(randomValue => {
                const v1 = roll(live, genre, tier, randomValue);
                const v2 = roll(preview, genre, tier, randomValue);
                return { genre, tier, randomValue, equal: JSON.stringify(v1) === JSON.stringify(v2), v1, v2 };
            });
        });
        return {
            directoriesIdentical,
            artistCount: live.length,
            filteringParity: rolls.every(item => item.equal),
            randomSelectionParity: rolls.every(item => item.equal),
            resultCardParity: rolls.every(item => JSON.stringify(item.v1.card) === JSON.stringify(item.v2.card)),
            spotifyLinkParity: live.every((artist, index) => artist.spotify === preview[index].spotify),
            imageParity: live.every((artist, index) => artist.image === preview[index].image),
            rollAgainParity: rolls.every(item => item.equal),
            testedRolls: rolls.length,
            mismatches: rolls.filter(item => !item.equal)
        };
    }

    async function loadJson(url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not load ${url}.`);
        return response.json();
    }

    async function runBrowserExperiment() {
        const [live, preview] = await Promise.all([
            loadJson("../../data/artists.json"), loadJson("../../data/artists-v2.preview.json")
        ]);
        const report = compare(live, preview);
        document.getElementById("status").textContent = report.mismatches.length ? "Parity failed." : "Parity passed.";
        document.getElementById("report").textContent = JSON.stringify(report, null, 2);
        const button = document.getElementById("rollAgain");
        button.disabled = false;
        button.addEventListener("click", function() {
            document.getElementById("report").textContent = JSON.stringify(compare(live, preview), null, 2);
        });
    }

    const api = { card, compare, roll };
    if (typeof module === "object" && module.exports) module.exports = api;
    else runBrowserExperiment().catch(error => {
        document.getElementById("status").textContent = "Parity experiment failed: " + error.message;
    });
})(typeof globalThis !== "undefined" ? globalThis : this);
