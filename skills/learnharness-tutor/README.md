# learnharness-tutor — LearnHarness's teaching method as a Claude skill

This skill packages the LearnHarness teaching and practice method (as of release 0.4.1, commit `e69e852`) for plain chat in Claude.ai: probe what you already understand → plan a dependency map → teach one reasoning step at a time with predict-and-check questions → separate practice sessions with a hint ladder and retests.

It is the method only. The app's interface (question dock, confidence slider, collapsible checks), its background workers (research, demo builder, PDF reader) and its knowledge graph are not included. Their place is taken by plain-text conventions, Claude's own tools (web search, artifacts) and your Project files.

## Files

| Path | In the upload | Purpose |
|---|---|---|
| `SKILL.md` | yes | Entry point: philosophy, session flow, chat protocol, voice, accuracy, formatting |
| `references/probe.md` | yes | Measuring the goal and the edge of your understanding |
| `references/method.md` | yes | The two principles (unconditional truths first; "how could I have discovered this?") |
| `references/planning.md` | yes | The minimal plan and the Mermaid plan map |
| `references/teaching.md` | yes | One step at a time; predict → teach → check |
| `references/questions.md` | yes | Question format, option craft, grading, confidence |
| `references/practice.md` | yes | The practice session: modes, selection, hints, verdicts, retests |
| `LICENSE` | yes | AGPL-3.0, same as LearnHarness |
| `README.md` | no | This guide |
| `learnharness-tutor.zip` | — | The upload: the folder above, without this README |

## Install (once)

1. In Claude.ai open **Settings → Capabilities** and turn on **Code execution and file creation** (skills need it).
2. In **Settings → Capabilities → Skills**, choose **Upload skill** and select `learnharness-tutor.zip`.
3. Make sure the skill's toggle is on.

Menu names can differ slightly between Claude.ai versions. If you can't find them, search the Claude help center for "custom skills".

Recommended: turn on **extended thinking** in the chat. The skill tells Claude to commit each question's correct answer, and each practice problem's model solution, privately before asking. With extended thinking that commitment really happens before you see the question.

## One Project per course

For each course, create a Project and:

- Upload the course materials (syllabus, lecture notes, problem sets, PDFs) as project knowledge.
- Paste this into the Project's custom instructions, edited for the course:

```text
Course: <course name>, <level/institution>.
Use the learnharness-tutor skill for every teaching and practice session in this project.
The course materials are in the project knowledge; read them yourself when I reference them.
I usually dictate — read my messages leniently for speech-to-text errors.
```

Start each new topic in a new chat inside the Project.

## How to use it

**Start a teaching session:** "Teach me <topic>" or "I want to understand <topic>". Claude probes first (graded **Probe** questions plus open questions about your goal), writes an **Assessment**, presents a plan with a Mermaid map, and waits for your OK before teaching.

**Start a practice session:** "Practice <topic>" or "Give me problems on lecture 5". Problems arrive one at a time as **Problem N** blocks.

**Answering a question** — any order, any words:

```text
B, 70%, because the inner derivative gets multiplied in…
```

- the letter, or your own words for free recall; `idk` if you don't know
- your confidence, 0–100%
- everything else counts as your **thinking**
- start a part with `reading:` for what you thought while reading the explanation

**Commands:**

| Say | Effect |
|---|---|
| `free recall` / `multiple choice` | switch the question mechanic (default: multiple choice) |
| `plan` | show the plan map again |
| `next` | practice: next problem (problems never come without it) |
| `give up` / `skip` | practice: drop the current problem (ask for the solution if you want it) |

## Mapping from the app

| In the LearnHarness app | Here |
|---|---|
| Prober → `probe_done` → Teacher hand-off | One conversation; the **Assessment** message marks the switch |
| `plan_init` live plan map | Mermaid artifact, updated when the plan changes |
| Quiz dock: options, confidence slider, thinking field | Text answer: letter + % + thinking |
| "Check your understanding" collapsed button | Check placed last in the message, after a horizontal rule |
| Reading-thinking field | `reading:` in your answer |
| Hidden committed answer / model solution | Committed in Claude's private reasoning |
| `problem` / `conclude` tools, Next button, discard | **Problem N** blocks, conclusion + **Solution**, `next`, `give up` |
| `research` job | Claude's web search (if enabled) |
| `pdf` job, learner file tools | Project knowledge and uploads |
| `demo` / `visual` jobs | Interactive HTML / SVG artifacts |
| Knowledge graph, graph tools, extraction | Not included |

## Rebuilding the zip

After editing the files, from the repository root:

```sh
python3 -c "import zipfile,pathlib; r=pathlib.Path('skills/learnharness-tutor'); z=zipfile.ZipFile(r/'learnharness-tutor.zip','w',zipfile.ZIP_DEFLATED); [z.write(p, pathlib.Path('learnharness-tutor')/p.relative_to(r)) for p in sorted(r.rglob('*')) if p.is_file() and p.name not in ('README.md','learnharness-tutor.zip')]; z.close()"
```
