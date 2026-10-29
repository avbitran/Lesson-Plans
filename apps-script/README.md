# Online Tests (Google Apps Script)

A free online test system that runs entirely in a school Google account.

- **Students sign in with their school Google account.** No passwords. They open one link.
- **Classes.** Students join with a **class code**, are **imported from Google Classroom**, or are added by email.
- **Several teachers.** Teachers at the same school share one app, each with their own classes, tests and students. Teachers at other schools get their own copy from a link.
- **Read-aloud.** A 🔊 Listen button on every question, the instructions and reading passages, with a speed control.
- **Voice answers.** Students can record a spoken answer to any question with 🎤. You listen to it while grading.
- **Per-student accommodations.** Read-aloud, voice answers, and extra time (+25% to +100%).
- **Bagrut-style questions.** Multiple choice with one or several correct answers, Module E vocabulary **matching**, short answers marked automatically, open answers, and reading passages.
- **Create a test from a PDF with AI.** Give any AI chat the PDF and the app's ready-made instructions, paste the reply back, and check the draft.
- **Submit and grade.** Answers save automatically. Multiple choice, matching and short answers are marked for you; anything uncertain is flagged "Check". You mark the rest, add comments, and return the test.
- **Exam mode.** Every time a student leaves the test it's recorded with the time. After a number of warnings you choose, the test **pauses until you unlock it** or **submits itself**.
- **👁 Student view.** See any test, or a student's home page, exactly as students do. Nothing is saved.

Everything is stored in **a Google Sheet** and **a Drive folder** in the account of whoever set it up.

---

## Installing it (about 5 minutes)

If another teacher sent you an **install link** (it ends in `/copy`):

1. Open the link while signed in to your **school** Google account and click **Make a copy**.
2. In the copy, open **Extensions → Apps Script**.
3. In the list next to **▷ Run** at the top, choose **authorize**, then click **▷ Run**. Allow everything Google asks for and tick every box. (If you see "Google hasn't verified this app", click **Advanced → Go to … (unsafe)**: it's your own copy.)
4. Click **Deploy → New deployment**, click the ⚙️ gear and choose **Web app**. Set **Execute as: Me** and **Who has access: Anyone within [your school]**, then **Deploy**.
5. Copy the **Web app URL**. That's your app: open it, and give the same link to your students.

The copy's first tab, *Start here*, has the same steps.

<details>
<summary>Installing from scratch, without an install link</summary>

1. Go to [sheets.new](https://sheets.new) and name the Sheet *Online Tests*.
2. **Extensions → Apps Script.** Replace everything in `Code.gs` with [the app's code](https://raw.githubusercontent.com/avbitran/Lesson-Plans/claude/online-student-testing-system-cv0t2z/apps-script/dist/Code.gs) (Ctrl+A, Ctrl+C there; Ctrl+A, Ctrl+V in the editor) and save.
3. For Google Classroom import: ⚙️ **Project Settings** → tick **Show "appsscript.json" manifest file in editor**. Open `appsscript.json` in the editor and replace it with [this manifest](https://raw.githubusercontent.com/avbitran/Lesson-Plans/claude/online-student-testing-system-cv0t2z/apps-script/dist/appsscript.json). Save.
4. Continue from step 3 above (authorize, deploy).

</details>

---

## Using it

**Classes.** Create a class, then get students in. You can combine these:
- **Class code.** Turn joining on, and students open the app link and type the code (like `ENG-4821`). Choose whether they join straight away or wait for your approval. Turn joining off when everyone is in.
- **Google Classroom.** Load your Classroom classes and import the students. This works for the person who installed the app only, because Google runs the app with their account. **Sync from Classroom again** picks up new students.
- **By email**, for a single student.

Read-aloud, voice answers and extra time are set per student, and every teacher who has that student sees the same settings.

**Tests.** Use **+ New test**, **Import JSON**, or **✨ Create from PDF with AI**. Tick the classes the test is for (none ticked means all your classes), set it to **Open**, and save. **👁 Student view** shows it exactly as a student sees it.

**Results.** Click the test's name to watch live, then **Grade** each student and **Save & return to student**.

**Teachers** (admin only). Add colleagues' school emails. They open the same app link and see their own empty Tests and Classes pages. **Make an installable copy** creates the install link for a teacher at another school.

**The link for students** is the **Web app URL**, ending in `/exec`. To find it again: Apps Script editor → **Deploy → Manage deployments**. Don't send the editor's address or a link ending in `/dev`.

---

## Backing up

Everything is in your Google Sheet (answers, scores, the activity log) and a Drive folder (voice answers). To back up, open the Sheet and use **File → Make a copy**. The copy also carries the app's code, so don't deploy it; it's just a backup. Updates never delete data: they only add columns or tabs.

## Updating the app

1. **Back up** (above).
2. Open the Apps Script editor. Replace everything in `Code.gs` with [the latest code](https://raw.githubusercontent.com/avbitran/Lesson-Plans/claude/online-student-testing-system-cv0t2z/apps-script/dist/Code.gs) and save. To check you got the whole file, the last line should start with `const INDEX_HTML =`.
3. If the update notes say the manifest changed: ⚙️ **Project Settings** → tick **Show "appsscript.json" manifest file in editor**, replace `appsscript.json` with [the latest manifest](https://raw.githubusercontent.com/avbitran/Lesson-Plans/claude/online-student-testing-system-cv0t2z/apps-script/dist/appsscript.json), save, then run **authorize** once and allow everything.
4. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.** The link stays the same.

GitHub can take up to 5 minutes to show a new version of the file.

---

## Creating a test from a PDF

**Tests → ✨ Create from PDF with AI**: copy the instructions the app shows, give them and the PDF to an AI chat (Claude, Gemini or ChatGPT), and paste the whole reply back. It becomes a **draft**. AI gets things wrong, especially answer keys for exams without one, so check every question and answer before opening the test.

## The voice recorder page

Google doesn't let Apps Script pages use the microphone, so students record in a small pop-up page, `recorder.html`, hosted free on GitHub Pages at <https://avbitran.github.io/Lesson-Plans/apps-script/recorder.html>. Every installed copy uses it by default. To host it elsewhere, change the address under **Settings**.

## What exam mode can and can't do

It **can't stop** a student opening another window. No website can. It **detects** leaving (tab switch, Alt-Tab, clicking another window, leaving full screen when available), warns the student, logs it with timestamps, and pauses or submits the test after the number of warnings you set. For a complete lockdown on managed Chromebooks, a school's Google admin can open the app link in a locked kiosk/exam mode.

## Good to know

- **One attempt per student.** **Retake** on the results page deletes their attempt so they can start again.
- The **timer keeps running** if a student closes the page. When time runs out, what was saved is submitted.
- A test is **frozen for a student when they start it**. Editing it later doesn't change what they see or how they're graded.
- **Results to Google Sheets** copies a test's scores into a new tab of the Sheet.
- **Don't rename or delete** the data tabs (`students`, `classes`, `tests`, `attempts`, …) or their column headings.
- **If the app says Google didn't answer**, you're probably signed in to more than one Google account in that browser. Use an Incognito window or a Chrome profile with only the school account.

---

## For developers

`dist/Code.gs` (the whole app, pages included) and `dist/appsscript.json` are generated. Edit `src/` and run:

```bash
npm run build          # writes dist/
npm test               # server logic and the Sheets storage layer, against fakes
node test/harness.js   # the real pages with a fake google.script.run: http://localhost:3500/?as=teacher
```

- `src/server/`: `Core.js` (test validation, auto-marking), `Api.js` (all routes, permissions, the upgrade from the single-teacher version; storage passed in), `Store.js` (Sheets tables, columns found by header name, JSON split across cells), `Main.js` (`doGet`, `rpc`, identity, Drive, Classroom, installable copies).
- `src/client/`: the pages (plain JavaScript, hash routing).
- The page code is shipped base64-encoded and decoded by a small loader, because Google rewrites inline scripts when it serves Apps Script pages and the rewritten code can stop parsing. The harness's `/google?as=teacher` loads the page with `document.write` in an iframe, the way Google's wrapper does.
- Harness users: `?as=teacher` (admin), `?as=<any email>` (a student, or a guest who can join with a code). Its pretend Classroom has one class.
