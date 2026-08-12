const searchForm = document.getElementById("searchForm");
const artistQuery = document.getElementById("artistQuery");
const searchButton = document.getElementById("searchButton");
const statusMessage = document.getElementById("status");
const result = document.getElementById("result");
const artistImage = document.getElementById("artistImage");
const artistName = document.getElementById("artistName");
const artistUrl = document.getElementById("artistUrl");
const artistId = document.getElementById("artistId");
const possibleMatches = document.getElementById("possibleMatches");
const possibleMatchesList = document.getElementById("possibleMatchesList");

function showExactMatch(artist) {
    artistName.textContent = artist.name;
    artistId.textContent = artist.id;
    artistUrl.textContent = artist.spotifyUrl;
    artistUrl.href = artist.spotifyUrl;

    if (artist.imageUrl) {
        artistImage.src = artist.imageUrl;
        artistImage.alt = artist.name + " artist image";
        artistImage.hidden = false;
    } else {
        artistImage.removeAttribute("src");
        artistImage.alt = "";
        artistImage.hidden = true;
    }

    result.hidden = false;
    possibleMatches.hidden = true;
}

function showPossibleMatches(artists) {
    possibleMatchesList.replaceChildren();

    artists.forEach(function(artist) {
        const listItem = document.createElement("li");
        const name = document.createElement("strong");
        const details = document.createElement("p");
        const link = document.createElement("a");

        if (artist.imageUrl) {
            const image = document.createElement("img");
            image.src = artist.imageUrl;
            image.alt = artist.name + " artist image";
            listItem.append(image);
        }

        name.textContent = artist.name;
        details.textContent = "Artist ID: " + artist.id;
        link.textContent = "Open in Spotify";
        link.href = artist.spotifyUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";

        listItem.append(name, details, link);
        possibleMatchesList.append(listItem);
    });

    result.hidden = true;
    possibleMatches.hidden = false;
}

searchForm.addEventListener("submit", async function(event) {
    event.preventDefault();

    const query = artistQuery.value.trim();

    if (!query) {
        statusMessage.textContent = "Please enter an artist name.";
        result.hidden = true;
        possibleMatches.hidden = true;
        return;
    }

    searchButton.disabled = true;
    statusMessage.textContent = "Searching Spotify...";
    result.hidden = true;
    possibleMatches.hidden = true;

    try {
        const response = await fetch(
            "/api/spotify/search?artist=" + encodeURIComponent(query)
        );
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "The Spotify search failed.");
        }

        if (data.matchType === "exact") {
            showExactMatch(data.artist);
            statusMessage.textContent =
                "Found an exact case-insensitive artist-name match.";
        } else {
            showPossibleMatches(data.artists);
            statusMessage.textContent =
                "No exact artist-name match was found. Review these possible matches.";
        }
    } catch (error) {
        statusMessage.textContent = error.message;
        result.hidden = true;
        possibleMatches.hidden = true;
    } finally {
        searchButton.disabled = false;
    }
});
