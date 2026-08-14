let artists = [];
let currentArtist = null;

function getBrowserStorage() {
    try {
        return window.localStorage;
    } catch (error) {
        return {
            getItem() { return null; },
            setItem() { throw new Error("Browser storage is unavailable."); }
        };
    }
}

const browserStorage = getBrowserStorage();
const myArtistsStore = MusicRollMyArtists.createMyArtistsStore(browserStorage);
const behaviorEvents = MusicRollBehaviorEvents.createEventRecorder(browserStorage);

const rollForm = document.getElementById("rollForm");
const genreSelect = document.getElementById("genre");
const tierSelect = document.getElementById("tier");
const rollButton = document.getElementById("rollButton");
const rollAgainButton = document.getElementById("rollAgainButton");
const result = document.getElementById("result");
const loadingStatus = document.getElementById("loadingStatus");
const artistName = document.getElementById("artistName");
const artistInfo = document.getElementById("artistInfo");
const artistImage = document.getElementById("artistImage");
const spotifyLink = document.getElementById("spotifyLink");
const saveArtistButton = document.getElementById("saveArtistButton");
const myArtistsButton = document.getElementById("myArtistsButton");
const savedArtistCount = document.getElementById("savedArtistCount");
const myArtistsDialog = document.getElementById("myArtistsDialog");
const closeMyArtistsButton = document.getElementById("closeMyArtistsButton");
const myArtistsList = document.getElementById("myArtistsList");
const collectionAnnouncement = document.getElementById("collectionAnnouncement");

function eventDetails(artist) {
    return {
        musicRollId: artist?.musicRollId,
        genreFilter: genreSelect.value,
        tierFilter: tierSelect.value
    };
}

function recordBehavior(type, artist) {
    behaviorEvents.record(type, eventDetails(artist));
}

function updateSavedCount() {
    savedArtistCount.textContent = String(myArtistsStore.getIds().length);
}

function updateSaveButton(artist) {
    const canSave = MusicRollMyArtists.isValidMusicRollId(artist?.musicRollId);
    const isSaved = canSave && myArtistsStore.has(artist.musicRollId);
    saveArtistButton.disabled = !canSave;
    saveArtistButton.setAttribute("aria-pressed", String(isSaved));
    saveArtistButton.textContent = isSaved ? "♥ In My Artists" : "＋ Add to My Artists";
}

function showStatus(message, state = "ready") {
    loadingStatus.textContent = message;
    loadingStatus.dataset.state = state;
    loadingStatus.hidden = false;
}

async function loadArtists() {
    try {
        const response = await fetch("data/artists.json");

        if (!response.ok) {
            throw new Error("Could not load the artist directory.");
        }

        const artistData = await response.json();
        const normalizedArtists =
            MusicRollArtistModel.adaptArtistDirectory(artistData);
        artists = normalizedArtists.map(function(artist, index) {
            const musicRollId = artistData[index]?.musicRollId;
            return musicRollId ? { ...artist, musicRollId } : artist;
        });
        rollButton.disabled = false;
        rollAgainButton.disabled = false;
        updateSavedCount();
        showStatus("The artist directory is ready. Make your picks and roll.");
    } catch (error) {
        console.error("Music Roll could not load the artist directory.", error);
        showStatus(
            "Music Roll could not load the artist directory. Please try again later.",
            "error"
        );
    }
}

function showArtist(randomArtist) {
    currentArtist = randomArtist;
    artistName.textContent = randomArtist.name;
    artistInfo.textContent = randomArtist.genre + " • " + randomArtist.tier;
    spotifyLink.href = randomArtist.spotify;
    artistImage.src = randomArtist.image;
    artistImage.alt = randomArtist.name + " artist portrait";
    artistImage.hidden = false;
    updateSaveButton(randomArtist);
    result.hidden = false;
    loadingStatus.hidden = true;
    result.focus({ preventScroll: true });
    result.scrollIntoView({ behavior: "smooth", block: "nearest" });
    recordBehavior("artist_impression", randomArtist);
}

function rollArtist() {
    const selectedGenre = genreSelect.value;
    const selectedTier = tierSelect.value;

    const matchingArtists = artists.filter(function(artist) {
        return artist.genre === selectedGenre && artist.tier === selectedTier;
    });

    if (matchingArtists.length === 0) {
        result.hidden = true;
        showStatus(
            "No artists are available for that combination yet. Try another genre or depth.",
            "error"
        );
        return;
    }

    const randomNumber = Math.floor(Math.random() * matchingArtists.length);
    const randomArtist = matchingArtists[randomNumber];
    showArtist(randomArtist);
}

artistImage.addEventListener("error", function() {
    artistImage.removeAttribute("src");
    artistImage.alt = "";
    artistImage.hidden = true;
});

function toggleSavedArtist() {
    if (!MusicRollMyArtists.isValidMusicRollId(currentArtist?.musicRollId)) return;
    const wasSaved = myArtistsStore.has(currentArtist.musicRollId);
    const changed = wasSaved
        ? myArtistsStore.remove(currentArtist.musicRollId)
        : myArtistsStore.add(currentArtist.musicRollId);
    if (!changed) return;

    updateSaveButton(currentArtist);
    updateSavedCount();
    recordBehavior(wasSaved ? "artist_unsaved" : "artist_saved", currentArtist);
    collectionAnnouncement.textContent = wasSaved
        ? `${currentArtist.name} removed from My Artists.`
        : `${currentArtist.name} added to My Artists.`;
    if (!wasSaved) {
        saveArtistButton.classList.remove("just-saved");
        requestAnimationFrame(() => saveArtistButton.classList.add("just-saved"));
    }
}

function createSavedArtistCard(artist) {
    const card = document.createElement("article");
    card.className = "saved-artist-card";

    const image = document.createElement("img");
    image.src = artist.image;
    image.alt = artist.name + " artist portrait";
    image.addEventListener("error", () => image.hidden = true);

    const details = document.createElement("div");
    const name = document.createElement("h3");
    const metadata = document.createElement("p");
    name.textContent = artist.name;
    metadata.textContent = artist.genre + " • " + artist.tier;
    details.append(name, metadata);

    const actions = document.createElement("div");
    actions.className = "saved-artist-actions";
    const spotify = document.createElement("a");
    spotify.className = "saved-spotify-link";
    spotify.href = artist.spotify;
    spotify.target = "_blank";
    spotify.rel = "noopener noreferrer";
    spotify.textContent = "Spotify";
    spotify.addEventListener("click", () => recordBehavior("spotify_clicked", artist));
    const remove = document.createElement("button");
    remove.className = "remove-saved-button";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${artist.name} from My Artists`);
    remove.addEventListener("click", function() {
        if (!myArtistsStore.remove(artist.musicRollId)) return;
        recordBehavior("artist_unsaved", artist);
        collectionAnnouncement.textContent = `${artist.name} removed from My Artists.`;
        updateSavedCount();
        updateSaveButton(currentArtist);
        renderMyArtists();
    });
    actions.append(spotify, remove);
    card.append(image, details, actions);
    return card;
}

function renderMyArtists() {
    const savedIds = myArtistsStore.getIds();
    const artistById = new Map(artists.map(artist => [artist.musicRollId, artist]));
    const savedArtists = savedIds.map(id => artistById.get(id)).filter(Boolean);
    myArtistsList.replaceChildren();
    if (savedArtists.length === 0) {
        const empty = document.createElement("p");
        empty.className = "collection-empty";
        empty.textContent = "No saved artists yet. Roll for an artist and add one you want to hear again.";
        myArtistsList.append(empty);
        return;
    }
    myArtistsList.append(...savedArtists.map(createSavedArtistCard));
}

rollForm.addEventListener("submit", function(event) {
    event.preventDefault();
    rollArtist();
});

rollAgainButton.addEventListener("click", function() {
    if (currentArtist) recordBehavior("roll_again", currentArtist);
    rollArtist();
});
saveArtistButton.addEventListener("click", toggleSavedArtist);
spotifyLink.addEventListener("click", function() {
    if (currentArtist) recordBehavior("spotify_clicked", currentArtist);
});
myArtistsButton.addEventListener("click", function() {
    renderMyArtists();
    myArtistsDialog.showModal();
});
closeMyArtistsButton.addEventListener("click", () => myArtistsDialog.close());
myArtistsDialog.addEventListener("click", function(event) {
    if (event.target === myArtistsDialog) myArtistsDialog.close();
});

loadArtists();
