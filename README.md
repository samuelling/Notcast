# Notcast

Episodes in which nothing happens. Notcast looks like a podcast app, but every "episode" is the sound of ordinary life: someone cooking in the next room, a drive, a walk. Gentle and not urgent. A megaZINE piece.

**Play it:** https://samuelling.github.io/notcast/

## The Kitchen (first show)

Every sound is synthesized live in the browser with the Web Audio API. Nothing is recorded.

- **An episode is a seed.** `(show, episode number)` deterministically generates the dish, weather, household (is there a wall clock?), timeline, chapters, captions, title and show notes. Ep. 14 always plays back the same Tuesday. A new episode "airs" every Thursday, counted from Ep. 1 on January 8, 2026.
- **Beds** are looping noise sources whose gains follow keyframed layer functions: room tone, fridge hum (60 Hz harmonics plus fan), rain, sizzle (hiss, dense crackle, sparse spits), boil rumble, running water, kettle.
- **Events** (a chop, a lid, the cutlery drawer) are scheduled with a short lookahead against the AudioContext clock. Most use modal synthesis: an impulse into a few tuned, decaying partials whose ratios differ by material (metal, ceramic, glass, wood, cast iron, pot lid).
- **Micro events** (bubbles, raindrops, droplets, clock ticks) are generated per one-second bucket from a seeded RNG, so they stay deterministic and the episode is seekable.

Some physics that made it in:

- Bubbles are sine chirps that sweep upward as they collapse. A lid on the pot is a lowpass.
- Filling a pot or kettle is a narrow resonance that rises in pitch as the air column above the water shortens.
- A settling pot lid bounces like a dropped coin: each impact quieter and sooner than the last.
- Stirring a mug of hot tea: the spoon's tinks rise in pitch as bubbles clear and sound travels faster through the liquid (the allassonic, or "hot chocolate", effect).

The page also shows SDH-style closed captions of what you'd hear and a plan view of the kitchen that lights up where each sound is coming from (sounds are panned to match).

## Files

- `js/episode.js` — seeded episode generator (pure, no audio; runs in Node too)
- `js/engine.js` — Web Audio engine: beds, event synths, transport, sleep timer
- `index.html` — the podcast player UI

## Porting to iOS

The generator ports directly (it's just seeded math). The engine maps to `AVAudioEngine`: noise loops as `AVAudioPlayerNode` buffers into `AVAudioUnitEQ` filters, events as scheduled buffers or `AVAudioSourceNode` render blocks, panning via the mixer. Use the `audio` background mode and `MPNowPlayingInfoCenter` / `MPRemoteCommandCenter` for lock-screen controls. On the web, iOS Safari may suspend audio when the screen locks.

## Next shows

- **The Drive** — road roar tracking speed, a turn signal, wipers, passing cars with Doppler, a Markov chain of cruising / slowing / red light.
- **The Walk** — wind, footsteps by surface (gravel, leaves, pavement), FM birdsong, distant traffic.
