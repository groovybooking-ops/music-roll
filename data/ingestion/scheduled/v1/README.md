# Scheduled ingestion store v1

This is the durable root for scheduled Music Roll discovery. Scheduled-run manifests and immutable phase events will be stored under `runs/`; generalized provider checkpoints use `checkpoints/`; the shared candidate, discovery, evidence, cache, and index data will use `store/`.

Stage 1 creates no live run or candidate artifacts here. Historical pilot stores remain isolated under `data/ingestion/pilots/`.
