let artists = [];

const rollButton = document.getElementById("rollButton");
const rollAgainButton = document.getElementById("rollAgainButton");
const result = document.getElementById("result");
const loadingStatus = document.getElementById("loadingStatus");

function isValidArtistDirectory(data) {
    const requiredFields = [
        "name",
        "genre",
        "tier",
        "spotifyId",
        "spotify",
        "image",
        "instagram",
        "tiktok"
    ];

    return Array.isArray(data) && data.length > 0 && data.every(function(artist) {
        return requiredFields.every(function(field) {
            return typeof artist[field] === "string" && artist[field].trim() !== "";
        });
    });
}

async function loadArtists() {
    try {
        const response = await fetch("data/artists.json");

        if (!response.ok) {
            throw new Error("Could not load the artist directory.");
        }

        const artistData = await response.json();

        if (!isValidArtistDirectory(artistData)) {
            throw new Error("The artist directory contains invalid data.");
        }

        artists = artistData;
        rollButton.disabled = false;
        rollAgainButton.disabled = false;
        loadingStatus.hidden = true;
    } catch (error) {
        loadingStatus.textContent =
            "Music Roll could not load the artist directory. Please try again later.";
    }
}

function rollArtist() {
    const selectedGenre = document.getElementById("genre").value;
    const selectedTier = document.getElementById("tier").value;

    const matchingArtists = artists.filter(function(artist) {
        return artist.genre === selectedGenre && artist.tier === selectedTier;
    });

    if (matchingArtists.length === 0) {
        alert("No artists found for that roll yet 🎲");
        return;
    }

    const randomNumber = Math.floor(Math.random() * matchingArtists.length);
    const randomArtist = matchingArtists[randomNumber];

  document.getElementById("artistName").textContent =
    "🎲 You rolled " + randomArtist.name;

document.getElementById("artistInfo").textContent =
    randomArtist.genre + " • " + randomArtist.tier; 
   document.getElementById("spotifyLink").href = randomArtist.spotify;
   document.getElementById("artistImage").src = randomArtist.image;
   document.getElementById("artistImage").style.display = "inline-block";
   result.hidden = false;
}

rollButton.addEventListener("click", rollArtist);
rollAgainButton.addEventListener("click", rollArtist);

loadArtists();
