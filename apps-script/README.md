# Online Tests (Google Apps Script)

A free online test system that runs entirely in your school Google account.

- **Students sign in with their school Google account.** No passwords to hand out. They open one link.
- **Read-aloud.** A 🔊 Listen button on every question, the instructions and reading passages, with a speed control.
- **Voice answers.** Students can record a spoken answer to any question with 🎤. You listen to it while grading.
- **Per-student accommodations.** Read-aloud, voice answers, and extra time (+25% to +100%), set by you for each student, or read-aloud/voice answers for a whole test.
- **Submit and grade.** Answers save automatically. Multiple choice and short answers are marked for you, and anything uncertain is flagged "Check". You mark the rest, add comments, and return the test.
- **Exam mode.** Every time a student leaves the test (another tab, window or app) it's recorded with the time. After a number of warnings you choose, the test **pauses until you unlock it** or **submits itself**. Copy/paste is blocked.
- **Live view** of who's working, their progress, time left and how often they left the test.

Everything is stored in **a Google Sheet** and **a Drive folder** in your account.

---

## Setting it up (about 15 minutes, once)

Do all of this while signed in to your **school** Google account.

### 1. Create the app

1. Go to **[sheets.new](https://sheets.new)** to make a new Google Sheet. Name it something like *Online Tests*.
2. In the Sheet, open **Extensions → Apps Script**. A code editor opens with a file called `Code.gs`.
3. Open [this link to the app's code](https://raw.githubusercontent.com/avbitran/Lesson-Plans/claude/online-student-testing-system-cv0t2z/apps-script/dist/Code.gs). It's one long page of text. Select everything (Ctrl+A), copy (Ctrl+C), go back to the editor, select everything there (Ctrl+A), and paste (Ctrl+V), **replacing** what was there.
4. Click 💾 **Save**. That's the whole app: one file.

### 2. Publish it to your school

1. Click **Deploy → New deployment**. Click the ⚙️ gear next to *Select type* and choose **Web app**.
2. Set:
   - **Execute as:** *Me*
   - **Who has access:** *Anyone within [your school]*
3. Click **Deploy**. Google asks you to authorize it: choose your account and **Allow**. (If you see "Google hasn't verified this app", click **Advanced → Go to … (unsafe)**. It's your own script.)
4. **Make sure every permission box is ticked.** Google may list permissions with checkboxes. Leave them all ticked, including Google Drive, which voice answers need. If you missed one, open the editor, choose **authorize** in the function list next to **▷ Run**, click **Run**, and tick everything.
5. Copy the **Web app URL**. **This is the link to the app**, for you and your students. Open it: you're the teacher, because you own it.

### 3. Turn on the voice recorder page (GitHub Pages)

Google doesn't let Apps Script pages use the microphone, so students record in a small pop-up page hosted free on GitHub.

1. In this GitHub repo, go to **Settings → Pages**.
2. Under *Build and deployment*, choose **Deploy from a branch**, pick the branch that contains this `apps-script` folder, folder **/ (root)**, and click **Save**.
3. After a minute or two, check that this opens: <https://avbitran.github.io/Lesson-Plans/apps-script/recorder.html>. It should say "Open this from your test", which is correct when opened directly.

That address is already the app's default. If you host the recorder somewhere else, change it under **Students → Settings** in the app.

### 4. Add students and a test

1. In the app, go to **Students** and paste one student per line: `school email, name, class`. Tick read-aloud, voice answers or extra time for students who need them.
2. Go to **Tests → Import JSON** and pick [`samples/past-simple-vs-past-progressive.json`](samples/past-simple-vs-past-progressive.json) (download it first), or click **+ New test**.
3. Set **Classes** (leave empty for all students) and set the status to **Open**, then **Save**. Use **Preview as student** to hear the read-aloud.
4. Give students the web app link (for example in Google Classroom). They see the test, press **Start**, and you watch from **Tests → (the test)**.

---

## What to try before a real test

Some of this depends on how your school set up Google and the Chromebooks, so try it once with one or two students (or a second account):

- **Voice answers:** students need to allow pop-ups and the microphone the first time. If the school blocks `github.io`, host `recorder.html` elsewhere and change the address in Settings.
- **Full screen:** Google's frame may not allow full screen. If it doesn't, the test runs normally without it, and leaving the test is still detected and logged. The activity log says "Full screen is not available".
- **Read-aloud** uses the Chromebook's built-in voices. Check how they sound in Preview.
- **Class size:** Google limits how many requests one script handles at once. It's built to stay well under that for a class (answers save every 15 seconds), but run a small trial first.

## What exam mode can and can't do

It **can't stop** a student opening another window. No website can. It **detects** leaving (tab switch, Alt-Tab, clicking another window, leaving full screen when available), warns the student, logs it for you with timestamps, and pauses or submits the test after the number of warnings you set.

For a complete lockdown on managed Chromebooks, ask your school's Google admin to open the app link in a locked kiosk/exam mode for your students. You don't need admin access for anything else here.

## Updating the app later

Paste the new `Code.gs`, save, then **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The link stays the same.

## Good to know

- **One attempt per student.** To let someone retake a test, press **Retake** on the results page, which deletes their attempt.
- The **timer keeps running** if a student closes the page. When time runs out, what was saved is submitted.
- A test is **frozen for a student when they start it**. Editing it later doesn't change what they see or how they're graded.
- **Results to Google Sheets** on a test's results page copies the scores into a new tab of your Sheet.
- **Other teachers:** add their emails under **Students → Teachers**. Every teacher sees all tests and students.
- **Don't edit the data tabs** (`students`, `tests`, `attempts`, …) in the Sheet by hand. The app relies on their exact columns.

---

## For developers

`dist/Code.gs` (the whole app, pages included) is generated. Edit `src/` and run:

```bash
npm run build   # writes dist/Code.gs (and dist/Index.html for the harness)
npm test        # server logic against an in-memory Sheet/Drive
node test/harness.js   # the real pages with a fake google.script.run: http://localhost:3500/?as=teacher
```

- `src/server/`: `Core.js` (test validation, auto-marking), `Api.js` (all routes; storage passed in), `Store.js` (Sheets tables, JSON split across cells), `Main.js` (`doGet`, `rpc`, identity, Drive).
- `src/client/`: the pages (plain JavaScript, hash routing), inlined into `Index.html` and embedded in `Code.gs` as `INDEX_HTML`.
- `recorder.html`: the pop-up recorder for GitHub Pages. It only talks to `*.googleusercontent.com` pages.
