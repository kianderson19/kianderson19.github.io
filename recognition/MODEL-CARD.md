# JOHAP portrait CNN v1 — 2026-10-17

**Purpose:** classify a visible hero portrait after the application's automatic
scoreboard/panel locator has found its location. It is not a whole-image scene
recognizer. Mislocated crops, unknown artwork, severe damage, or fully covered
portraits can remain unknown. No model can recover a hero hidden behind an
opaque eliminated-player skull from that portrait alone.

## Artifact

- Model ID: `johap-portrait-cnn-v1-20261017`
- 86,863 learned parameters; 347,452 bytes float32 weights.
- SHA-256: `2c24ba283f083ff69f2ebc219e12f66d23e70018d7bb6dabe68e129c05ea8a0e`
- Input: 48×48 RGB, `pixel/127.5-1`, NCHW; resize inside portable evaluator.
- Architecture: stride-2 Conv5 3→12, Conv3 12→24, Conv3 24→32,
  Conv3 32→48; flatten 432→128→55; ReLU except last linear output.
- Output: 54 hero IDs plus explicit `__unknown__`; sorted softmax scores.
- Gate: max score ≥0.78, first/second score margin ≥0.32, current roster
  inclusion, and a non-flat sufficiently sized input. **Scores are not calibrated
  probabilities or a claim of real-camera certainty.**
- Inference: local typed-array JavaScript; no external ML runtime, GPU requirement,
  network request, paid API, or recurring inference cost.

## Training and provenance

Trained from scratch with PyTorch 2.14.1, NumPy 2.5.4, Pillow 13.0.0 on Apple MPS,
56 epochs, 22,800 synthetic training examples; best checkpoint selected by a
separate augmentation-development seed. Training took approximately 161 seconds
on the development Mac. This is a reproducibility observation, not a guaranteed
training or phone-inference time.

The manifest records all 139 bundled source artwork paths and SHA-256 hashes.
Sources are the current, 2D scoreboard and legacy hero-icon directories.
Historical hero IDs are retained for training provenance and must be filtered
against the current application roster. No scoreboard fixture, user photograph,
video frame, screenshot-derived live variant, or pretrained network was trained
on. Approved source art remains copyright Blizzard Entertainment, Inc.

Augmentations: perspective, rotation, imperfect crop/scale, mirror, repeated
resampling, blur, JPEG compression, exposure, gamma, white balance, saturation,
synthetic moiré/scanline noise, partial occlusion. Artificial skulls, flat panels,
text/role-like symbols, and simple shapes train the unknown class.

## Validation scope

Both sets below share underlying icon artwork with training, with independent
augmentation seeds. They measure known-art robustness, not generalization to new
artwork or actual camera/monitor conditions.

| Set | Visible examples | Top-1 accuracy | Accepted coverage | Accuracy among accepted | Unknown false accepts |
| --- | ---: | ---: | ---: | ---: | ---: |
| Augmentation development | 3,240 | 97.78% | 85.43% | 99.96% | 0/180 |
| Harder augmentation holdout | 3,240 | 91.20% | 69.81% | 99.51% | 0/180 |

The explicit thresholds deliberately retain uncertain portraits as unknown.
Zero false accepts in 180 synthetic unknowns is not proof that arbitrary unseen
non-hero crops will always be rejected.

Independent integration QA uses additional camera-style composites made from
redacted held-out scoreboard fixtures, excluded from training. These tests
separate locator accuracy from classifier accuracy. They are synthetic
photographed-screen approximations, **not actual iPhone photographs**; the QA
report is the authority for whole-photo results. Actual rough iPhone-capture
recognition remains unverified until a physical capture completes successfully.

The versioned PyTorch reference tests all 55 logits on four independently
generated portrait/unknown inputs against the JavaScript evaluator with absolute
tolerance 0.0005, verifies the model hash, and checks rejection of flat panels,
unavailable heroes and malformed model files. Desktop inference timings do not
establish iPhone/Android latency.

## Limitations and maintenance

Unknown skins/portrait revisions, very small or out-of-focus faces, glare,
occlusions, heavy moiré, color-accessibility themes and wrong panel geometry may
require rejection. New hero artwork needs new approved source assets and a
retrained/versioned model. Do not silently classify a new hero as an old one.
Continue showing editable recognition results and preserve prior selections for
unresolved slots. Do not lower rejection gates merely to claim more recognized
heroes. There is no remote photo collection or model-training telemetry.

## Rights

The network architecture, training script and portable evaluator are JOHAP
project code. No third-party model architecture implementation or pretrained
weights are embedded. Offline training-tool licenses remain their respective
licenses. Hero images retain Blizzard rights; this model card grants no license
to redistribute or reuse Blizzard art. See `LICENSE.txt`.
