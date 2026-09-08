# Space Drift

A local workspace becomes a two-layer universe: fly a small ship between repositories as planets, then land to explore folders as molecules and files as atoms. File bytes create additive mass; recent activity adds decaying excitation, gravity, heat and light.

The static browser app runs on Vercel and reads a folder chosen by the pilot, without uploading metadata or contents. The optional loopback Node server enriches each repository with read-only Git statistics and supports desktop opening. E and ranged probes open eligible files locally; the atlas and guided tours plan journeys across layers.

Implementation lives in this dedicated repository. `npm test`, `npm run check`, and `npm run build` validate the models, source boundaries, and static output. See [README](README.md) for controls, data limits and architecture, and [implementation notes](docs/spacetime-implementation.md) for the spacetime issue family and verification evidence.

This branch implements parent issue #9 and its eleven spacetime sub-issues, including the required probe and tour integrations. The separate action-gated onboarding redesign in #19 is outside this feature.
