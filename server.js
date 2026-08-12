const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const {
    SpotifyApiError,
    searchArtistByExactName
} = require("./lib/spotify-client");

dotenv.config({ quiet: true });

const app = express();
const port = Number(process.env.PORT) || 3000;

app.get("/", function(request, response) {
    response.sendFile(path.join(__dirname, "index.html"));
});

app.get("/index.html", function(request, response) {
    response.sendFile(path.join(__dirname, "index.html"));
});

app.get("/style.css", function(request, response) {
    response.sendFile(path.join(__dirname, "style.css"));
});

app.get("/script.js", function(request, response) {
    response.sendFile(path.join(__dirname, "script.js"));
});

app.get("/data/artists.json", function(request, response) {
    response.sendFile(path.join(__dirname, "data", "artists.json"));
});

app.get("/spotify-test.html", function(request, response) {
    response.sendFile(path.join(__dirname, "spotify-test.html"));
});

app.get("/spotify-test.js", function(request, response) {
    response.sendFile(path.join(__dirname, "spotify-test.js"));
});

app.get("/api/spotify/search", async function(request, response) {
    const artistName = String(request.query.artist || "").trim();

    if (!artistName) {
        return response.status(400).json({ error: "Enter an artist name." });
    }

    try {
        const searchResult = await searchArtistByExactName(artistName);

        if (!searchResult.exactMatch && searchResult.possibleMatches.length === 0) {
            return response.status(404).json({
                error: "Spotify did not find an artist with that name."
            });
        }

        if (searchResult.exactMatch) {
            return response.json({
                matchType: "exact",
                artist: searchResult.exactMatch
            });
        }

        return response.json({
            matchType: "possible",
            artists: searchResult.possibleMatches
        });
    } catch (error) {
        const isSafeSpotifyError = error instanceof SpotifyApiError;
        const safeMessage = isSafeSpotifyError
            ? error.message
            : "The local server could not connect to Spotify.";
        const statusCode = isSafeSpotifyError ? error.statusCode : 500;

        return response.status(statusCode).json({ error: safeMessage });
    }
});

app.listen(port, "127.0.0.1", function() {
    console.log(
        "Spotify developer test is running at http://127.0.0.1:" + port
    );
});
