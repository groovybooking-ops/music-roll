function idFromUrl(url, pattern) {
    return typeof url === "string" ? url.match(pattern)?.[1] || null : null;
}

function claimsFromSources({ spotifyArtistId, wikidata, discogs, musicBrainz }) {
    const claims = [
        { identifierType: "spotifyArtistId", value: spotifyArtistId, source: "music_roll_input", path: "verified_starting_identifier", independentOrigin: "music_roll" },
        { identifierType: "spotifyArtistId", value: wikidata.spotifyArtistId, source: "wikidata", path: "P1902", independentOrigin: "wikidata" },
        { identifierType: "wikidataQid", value: wikidata.wikidataQid, source: "wikidata", path: "entity", independentOrigin: "wikidata" },
        { identifierType: "musicBrainzArtistId", value: wikidata.musicBrainzArtistId, source: "wikidata", path: "P434", independentOrigin: "wikidata" },
        { identifierType: "discogsArtistId", value: wikidata.discogsArtistId, source: "wikidata", path: "P1953", independentOrigin: "wikidata" },
        { identifierType: "musicBrainzArtistId", value: musicBrainz.musicBrainzArtistId, source: "musicbrainz", path: "artist_record_id", independentOrigin: "musicbrainz" },
        { identifierType: "discogsArtistId", value: discogs.discogsArtistId, source: "discogs", path: "artist_record_id", independentOrigin: "discogs" }
    ];
    for (const relation of musicBrainz.externalUrls || []) {
        const values = {
            spotifyArtistId: idFromUrl(relation.url, /open\.spotify\.com\/artist\/([A-Za-z0-9]{22})/),
            wikidataQid: idFromUrl(relation.url, /wikidata\.org\/wiki\/(Q[1-9][0-9]*)/),
            discogsArtistId: idFromUrl(relation.url, /discogs\.com\/artist\/([0-9]+)/)
        };
        for (const [identifierType, value] of Object.entries(values)) if (value) claims.push({ identifierType, value, source: "musicbrainz", path: `url_relationship:${relation.relationshipType}`, independentOrigin: "musicbrainz" });
    }
    for (const url of discogs.artistUrls || []) {
        const qid = idFromUrl(url, /wikidata\.org\/wiki\/(Q[1-9][0-9]*)/);
        if (qid) claims.push({ identifierType: "wikidataQid", value: qid, source: "discogs", path: "artist_url", independentOrigin: "discogs" });
    }
    return claims.filter(claim => claim.value != null);
}

function compareIdentityEvidence(input) {
    const claims = claimsFromSources(input);
    const types = ["spotifyArtistId", "wikidataQid", "musicBrainzArtistId", "discogsArtistId"];
    const identifierComparison = Object.fromEntries(types.map(type => {
        const relevant = claims.filter(claim => claim.identifierType === type);
        const values = [...new Set(relevant.map(claim => claim.value))];
        return [type, {
            status: values.length === 0 ? "not_observed" : values.length === 1 ? "agreement" : "conflict",
            agreedValue: values.length === 1 ? values[0] : null,
            observedValues: values,
            claims: relevant,
            independentSourceCount: new Set(relevant.map(claim => claim.independentOrigin)).size,
            provenanceNote: "Repeated links are claims from their listed source, not new independent confirmations of the linked database record."
        }];
    }));
    return {
        identifierComparison,
        conflicts: Object.entries(identifierComparison).filter(([, result]) => result.status === "conflict").map(([identifierType, result]) => ({ identifierType, observedValues: result.observedValues })),
        supportingMetadata: {
            names: [
                { source: "wikidata", value: input.wikidata.name },
                { source: "discogs", value: input.discogs.name },
                { source: "musicbrainz", value: input.musicBrainz.name }
            ],
            musicBrainz: { artistType: input.musicBrainz.artistType, country: input.musicBrainz.country, area: input.musicBrainz.area, beginArea: input.musicBrainz.beginArea, lifeSpan: input.musicBrainz.lifeSpan, aliases: input.musicBrainz.aliases },
            discogs: { realName: input.discogs.realName, aliases: input.discogs.aliases, profile: input.discogs.profile }
        },
        confidenceScoreCalculated: false,
        automaticIdentityDecisionMade: false
    };
}

function auditSameNameMusicBrainzEntities(expectedMbid, candidates, detailedArtists) {
    const detailsById = new Map(detailedArtists.map(artist => [artist.musicBrainzArtistId, artist]));
    const entities = candidates.map(candidate => {
        const detail = detailsById.get(candidate.musicBrainzArtistId);
        const spotifyIds = [];
        const discogsIds = [];
        for (const relation of detail?.externalUrls || []) {
            const spotify = idFromUrl(relation.url, /open\.spotify\.com\/artist\/([A-Za-z0-9]{22})/);
            const discogs = idFromUrl(relation.url, /discogs\.com\/artist\/([0-9]+)/);
            if (spotify) spotifyIds.push(spotify);
            if (discogs) discogsIds.push(discogs);
        }
        return { ...candidate, selectedExactEntity: candidate.musicBrainzArtistId === expectedMbid, spotifyArtistIds: [...new Set(spotifyIds)], discogsArtistIds: [...new Set(discogsIds)] };
    });
    const competitors = entities.filter(entity => !entity.selectedExactEntity);
    return {
        exactDisplayNameEntityCount: entities.length,
        selectedEntityPresent: entities.some(entity => entity.selectedExactEntity),
        sameNameAmbiguity: competitors.length ? "multiple_exact_display_name_entities" : "none_observed",
        competingEntityCount: competitors.length,
        competingEntities: competitors,
        allExactNameEntities: entities,
        interpretation: "Same-name entities are an ambiguity warning separate from exact-ID cross-link agreement. Matching names do not prove identity."
    };
}

module.exports = { auditSameNameMusicBrainzEntities, claimsFromSources, compareIdentityEvidence };
