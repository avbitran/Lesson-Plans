# Online Tests

A small website for giving tests online. You build a test, students log in and take it, and you grade it.

- **Read-aloud.** A 🔊 Listen button on every question, the instructions and reading passages, with a speed control. You choose which students get it, or turn it on for the whole test.
- **Voice answers.** Selected students (or everyone) can record a spoken answer to any question with 🎤. You listen to it while grading.
- **Accounts.** You create student logins in bulk: paste "name, class" lines, then print the username/password slips. Students only see tests for their class.
- **Submit and grade.** Answers save every few seconds. Multiple-choice and short answers are marked automatically, and anything uncertain is flagged for you. You mark the rest, add comments, and return the test to the student.
- **Exam mode.** Full screen, copy/paste blocked, and every time a student leaves the test (another tab, window or app) it's recorded with a timestamp. After a number of warnings you choose, the test is **paused until you unlock it** or **submitted automatically**.
- **Accommodations per student.** Read-aloud, voice answers, and extra time (+25%, +33%, +50%, +100%).
- **Live view.** While a test runs you see who is working, their progress, time left and how many times they left the test. You can unlock, end or reset an attempt.
- Results export as CSV. Tests import and export as JSON. Hebrew and Arabic tests display right-to-left.

## What exam mode can and cannot do

A website **cannot stop** a student from opening another window. No browser allows that. What this does instead:

| | |
|---|---|
| Detects and logs leaving the test (tab switch, Alt-Tab, clicking another window, exiting full screen) | ✅ |
| Warns the student, then pauses or submits the test after N times | ✅ |
| On **Chromebooks / Chrome**, asks the browser to capture system shortcuts (such as Alt-Tab) while full screen, and Esc must be *held* to exit. Which shortcuts get captured depends on the ChromeOS version, so try it on one of your Chromebooks | ✅ |
| Blocks copy, paste, right-click, print and devtools shortcuts | ✅ |
| Stops a second window/device from continuing the same test (only the newest one can save) | ✅ |
| Physically prevents opening other apps | ❌ Needs a locked-down device (see below) |
| Stops a student using a phone next to them | ❌ Only supervision does |

### Managed Chromebooks

You don't need admin access for anything above. If you want a full lockdown (the Chromebook can't open anything except the test), ask your school's Google Workspace admin. Something like:

> Could you set up our online test site (`https://your-address`) so students' Chromebooks can open it in a locked exam mode? For example, as a kiosk web app for my students' organizational unit, or with all other sites blocked during tests.

With that in place, the leave-the-test logging stays on as a second layer.

## Running it

Needs **Node.js 22.13 or newer**. There are no other dependencies.

```bash
cd online-tests
npm start
```

Open http://localhost:3000. The first time, the server prints a **setup code** in its log. Enter it on the page to create your teacher account. (You can also set `SETUP_CODE` yourself in the environment.)

Then:
1. **Students** page: paste one student per line, `Name, Class`, then press **Create accounts**. Print the login slips. Tick read-aloud / voice answers / extra time for the students who need them.
2. **Tests** page: **+ New test**, or **Import JSON**. `samples/past-simple-vs-past-progressive.json` is the 10th-grade quiz from this repo, ready to import.
3. Set the test's **Classes** (or leave empty for all students), set status to **Open**, and save. Use **Preview as student** to hear the read-aloud first.
4. Students log in at the site's address and press **Start**.
5. Open the test from the **Tests** page to watch live, then **Grade** each submission and **Save & return to student**.

### Putting it online

Students need to reach it from home or school, so it has to run on a server with:

- **HTTPS.** Browsers only allow the microphone on `https://` sites, or on `localhost`. Voice answers won't work over plain `http://` on a school network.
- **A persistent disk** for the `data/` folder (database + recordings). Set `DATA_DIR` to that disk's path.

Any Node host works. For example, on **Render**: create a *Web Service* from this repo, set the root directory to `online-tests`, start command `npm start`, add a *Disk* mounted at `/var/data`, and set the environment variable `DATA_DIR=/var/data`. Disks need a paid instance, because the free tier wipes files on restart. Railway or Fly.io with a volume work the same way. Look for the setup code in the service's logs after the first deploy.

Back up the `DATA_DIR` folder. It holds everything.

### Settings (environment variables)

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `DATA_DIR` | `./data` | Database and recordings |
| `SETUP_CODE` | random, printed in the log | Only used until the first teacher account exists |
| `COOKIE_SECURE` | auto | Set to `1` to force secure cookies (auto-detected behind an HTTPS proxy) |

## Good to know

- **Read-aloud** uses the browser's built-in voices. Chromebooks and Chrome have good English and Hebrew voices. Use **Preview as student** to hear them.
- **One attempt per student.** To let someone retake a test, press **Retake** on the results page, which deletes their attempt.
- The **timer keeps running** if a student closes the page. When time runs out, whatever was saved is submitted.
- A test is **frozen for a student when they start it**. Editing it afterwards doesn't change what they see or how they're graded.
- All teacher accounts see all tests and students.
- **Short answers**: list every acceptable answer, one per line. Capitals, extra spaces, curly apostrophes and a final full stop are ignored. Anything else that doesn't match is flagged "Check" for you rather than silently marked wrong.

## Development

```bash
npm test   # API tests: accounts, a full attempt, locking, grading, permissions
```

Code layout: `server.js` (HTTP API), `lib/` (database, passwords, test validation and auto-marking), `public/` (the pages; plain JavaScript, no build step).
