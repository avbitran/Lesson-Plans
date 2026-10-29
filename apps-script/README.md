# Online Tests (Google Apps Script)

A free online test system that runs entirely in a school Google account.

- **Students sign in with their school Google account.** No passwords. They open one link.
- **Classes.** Students join with a **class code**, are **imported from Google Classroom**, or are added by email.
- **Several teachers.** Teachers at the same school share one app, each with their own classes, tests and students. Teachers at other schools get their own copy from a link.
- **Read-aloud.** A 🔊 Listen button on every question, the instructions and reading passages, with a speed control. Students can also **highlight part of a text** and press **🔊 Read this** to hear just that part. Choose the voice for each test: the free device voice, a **natural Google voice**, or your own **Chatterbox** voice server. Natural-voice audio is made once and saved in your Drive.
- **Voice answers.** Students can record a spoken answer to any question with 🎤. You listen to it while grading.
- **Per-student accommodations.** Read-aloud, voice answers, and extra time (+25% to +100%), set per student, or read-aloud/voice answers for a whole test.
- **Bagrut-style questions.** Multiple choice with one or several correct answers, **fill in the blanks** (several blanks per sentence, an optional word bank, typed or chosen from a drop-down), **matching**, **Module E vocabulary** (numbered items matched to definitions), short answers marked automatically, open answers, and reading passages. Hebrew and Arabic text is shown right-to-left automatically.
- **Create a test from a PDF or Word file with AI.** Give any AI chat the file and the app's ready-made instructions, paste the reply back, and check the draft.
- **Submit and grade.** Answers save automatically. Multiple choice, blanks, matching and short answers are marked for you; anything uncertain is flagged "Check". You mark the rest, add comments, and return the test.
- **Exam mode.** Every time a student leaves the test (another tab, window or app) it's recorded with the time. After a number of warnings you choose, the test **pauses until you unlock it** or **submits itself**. Copy/paste is blocked.
- **👁 Student view.** See any test, or a student's home page, exactly as students do, including a specific student's accommodations and (if you want) exam mode. Nothing is saved.
- **Live view** of who's working, their progress, time left and how often they left the test.

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

**Sharing a test.** **Share** next to a test: not shared, all teachers, or chosen teachers. They see it under **Shared with me**, can look at it in student view and **make their own copy** to edit and give their classes. They can't change yours or see your students' results.

**Names.** Google only tells the app email addresses, which at many schools are numbers. Click your name at the top right to set the name others see; the admin can set names on the Teachers page. Students' names come from Google Classroom or the join form, and ✏️ next to a student renames them.

**Teachers** (admin only). Add colleagues' school emails. They open the same app link and see their own empty Tests and Classes pages. **Make an installable copy** creates the install link for a teacher at another school.

**The link for students** is the **Web app URL**, ending in `/exec`. To find it again: Apps Script editor → **Deploy → Manage deployments**. Don't send the editor's address or a link ending in `/dev`.

---

## Backups

The app backs itself up. Each backup is a **separate Google Sheet** with a copy of every data tab (students, classes, tests, answers, marks, the activity log), saved in the Drive folder **Online Tests – backups**. Backups contain no app code, so they can't run as a second app.

- **Every night**, kept for 30 days. On by default; switch it in **Settings → Backups**.
- **Before every update.** The first time the app runs new code, it backs up before anything else touches the data. These are kept until you delete them.
- **Back up now** in **Settings → Backups**, any time.

Voice answers and read-aloud audio are files in Drive. Updates never delete them.

**Restoring** (Settings → Backups → *How to restore* has the same steps):
1. Click **Back up now**, so the current state is kept too.
2. Open the backup you want. Right-click the tab you need (for example `attempts`) → **Copy to** → **Existing spreadsheet** → choose the app's Sheet.
3. In the app's Sheet, rename the broken tab (for example to `attempts old`) and rename the copied tab to the exact original name (`attempts`).
4. Reload the app.

## Updating the app

1. **Back up** (above).
2. Open the Apps Script editor. Replace everything in `Code.gs` with [the latest code](https://raw.githubusercontent.com/avbitran/Lesson-Plans/claude/online-student-testing-system-cv0t2z/apps-script/dist/Code.gs) and save. To check you got the whole file, the last line should start with `const INDEX_HTML =`.
3. If the update notes say the manifest changed: ⚙️ **Project Settings** → tick **Show "appsscript.json" manifest file in editor**, replace `appsscript.json` with [the latest manifest](https://raw.githubusercontent.com/avbitran/Lesson-Plans/claude/online-student-testing-system-cv0t2z/apps-script/dist/appsscript.json), save, then run **authorize** once and allow everything.
4. **Deploy → Manage deployments → ✏️ → Version: New version → Deploy.** The link stays the same.

GitHub can take up to 5 minutes to show a new version of the file.

---

## Creating a test from a PDF or Word file

**Tests → ✨ Create from PDF/Word with AI** walks you through it:
1. Copy the instructions the app shows.
2. Open an AI chat (Claude, Gemini or ChatGPT), attach the PDF or Word file, paste the instructions, and send.
3. Paste the AI's whole reply back into the app. It becomes a **draft**.

The instructions tell the AI how to handle word banks, sentences with two blanks, verb-form gaps, matching, "translate and match" and translating sentences from Hebrew. AI gets things wrong, especially answer keys for exams without one, so check every question, option and correct answer before opening the test. Open answers the AI wasn't sure about start with "CHECK:" in the model answer. Pictures and tables become short descriptions in [brackets].

## Fill in the blanks and matching

**Fill in the blanks.** Type the sentences, one per line, with each answer in curly braces:

```
She opened a small {business} selling jewelry online.
It is very fun {to play|playing} videogames with my brother.
Unique {}
```

- `{to play|playing}`: either answer is right.
- `{}`: a blank you mark yourself (for example a translation).
- A sentence can have several blanks. Each blank is worth an equal share of the question's points.
- Add a **word bank** to show the words above the sentences. Used words are crossed out as students fill them in. Tick the drop-down option to make students choose from the bank instead of typing.
- Answers that match nothing you accepted are flagged **Check**, so you can give the point for a spelling like "organisation".

**Matching.** Enter each item with its match. Students see the matches mixed up (the same order for everyone) and pick one for each item. You can add extra wrong choices. Good for translations and "match the halves".

**Module E vocabulary.** The bagrut layout: numbered items (1–6) on one side, definitions on the other, and students choose an item's number for each definition. Items not used are distractors, an item used once is greyed out in the other drop-downs, and each correct match is worth the points you set (for example 2).

## The voice recorder page

Google doesn't let Apps Script pages use the microphone, so students record in a small pop-up page, `recorder.html`, hosted free on GitHub Pages at <https://avbitran.github.io/Lesson-Plans/apps-script/recorder.html>. Every installed copy uses it by default. To host it elsewhere, change the address under **Settings**.

## Read-aloud voices

Choose the voice in each test under **Read-aloud voice**:

| Voice | Sounds | Setup | Cost |
|---|---|---|---|
| **Device voice** | Depends on the Chromebook; can be robotic | None | Free |
| **Google natural voice** | Close to a real person | A Google Cloud key, once (below) | Free up to a monthly allowance, then paid |
| **Chatterbox** | Natural; can be your own cloned voice | Your own Chatterbox server (below) | Free (your computer does the work) |

With a natural voice, press **🔊 Prepare audio** in the test editor after the test is finished. The audio is made once, saved in the Drive folder *Online Tests – read-aloud audio*, and played to students from there. Use **▶ Try voice** to hear a sample first. If you edit a question after preparing, press Prepare audio again; until then, that question is read with the device voice.

### Google natural voice (about 15 minutes, once)

1. Go to [console.cloud.google.com](https://console.cloud.google.com/). If your school account isn't allowed, use a personal Google account; the key works with the app either way.
2. Create a project (any name), then go to **APIs & Services → Library**, find **Cloud Text-to-Speech API** and click **Enable**.
3. Google asks you to add a **billing account** (a card). It's required even for the free allowance. At the time of writing, [Google's pricing page](https://cloud.google.com/text-to-speech/pricing) lists 1 million free characters a month for the most natural voices (Chirp 3 HD and Neural2) and 4 million for WaveNet voices. A whole test is usually a few thousand characters, and audio is made only once per test.
4. Go to **APIs & Services → Credentials → Create credentials → API key**. Click the key, and under **API restrictions** choose **Restrict key → Cloud Text-to-Speech API**. Copy the key.
5. In the app: **Settings → Read-aloud voices**, paste the key and click **Save voices**.
6. In a test, choose **Google natural voice** and a voice name (the list has good English and Hebrew voices; any [Google voice name](https://cloud.google.com/text-to-speech/docs/list-voices-and-types) works).

### Chatterbox (your own voice server)

[Chatterbox](https://github.com/resemble-ai/chatterbox) is a free, open-source voice model that runs on your own computer (a graphics card helps a lot). The app talks to it through the OpenAI-style address `/v1/audio/speech`, which ready-made Chatterbox servers provide, for example [Chatterbox TTS API](https://github.com/travisvn/chatterbox-tts-api).

Google's servers make the audio, so they must be able to reach your Chatterbox server. A server that runs only on your computer (an address like `localhost:4123`) needs a public address:

1. Start your Chatterbox server.
2. Make a public address for it with a free tunnel, for example [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/): `cloudflared tunnel --url http://localhost:4123` prints an address like `https://something.trycloudflare.com`.
3. In the app: **Settings → Read-aloud voices**, paste that address as the Chatterbox server address (and a key if your server needs one).
4. In a test, choose **Chatterbox**, optionally a voice name your server knows, and press **🔊 Prepare audio**.

The computer and tunnel only need to be running **while you prepare the audio**, not while students take the test. A quick tunnel's address changes each time you start it, so paste the new one before preparing audio for another test.

**Hebrew:** the app sends Hebrew stretches separately, marked as Hebrew. Google reads them with a Hebrew voice. Chatterbox reads them correctly only if your server runs the multilingual Chatterbox model.

## What to try before a real test

Some of this depends on how your school set up Google and the Chromebooks, so try it once with one or two students (or a second account):

- **Voice answers:** students need to allow pop-ups and the microphone the first time. If the school blocks `github.io`, host `recorder.html` elsewhere and change the address in Settings.
- **Full screen:** Google's frame may not allow full screen. If it doesn't, the test runs normally without it, and leaving the test is still detected and logged. The activity log says "Full screen is not available".
- **Read-aloud:** the device voice depends on each Chromebook. Check how it sounds in 👁 Student view, or prepare a natural voice.
- **Class size:** Google limits how many requests one script handles at once. It's built to stay well under that for a class (answers save every 15 seconds), but run a small trial first.

## What exam mode can and can't do

It **can't stop** a student opening another window. No website can. It **detects** leaving (tab switch, Alt-Tab, clicking another window, leaving full screen when available), warns the student, logs it with timestamps, and pauses or submits the test after the number of warnings you set. For a complete lockdown on managed Chromebooks, a school's Google admin can open the app link in a locked kiosk/exam mode.

If an update needs a new permission (natural voices need permission to *connect to an external service*), Google asks once: in the editor choose **authorize** in the function list, click **▷ Run** and tick every box.

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

- `src/server/`: `Core.js` (test validation, auto-marking, read-aloud text), `Api.js` (all routes, permissions, the upgrade from the single-teacher version; storage passed in), `Store.js` (Sheets tables, columns found by header name, JSON split across cells), `Main.js` (`doGet`, `rpc`, identity, Drive, Classroom, installable copies, the Google and Chatterbox voice services).
- `src/client/`: the pages (plain JavaScript, hash routing), inlined into `Index.html` and embedded in `Code.gs` as `INDEX_HTML`.
- The page code is shipped base64-encoded and decoded by a small loader, because Google rewrites inline scripts when it serves Apps Script pages and the rewritten code can stop parsing ("Failed to execute 'write' on 'Document'"). The harness's `/google?as=teacher` loads the page with `document.write` in an iframe, the way Google's wrapper does.
- `recorder.html`: the pop-up recorder for GitHub Pages. It only talks to `*.googleusercontent.com` pages.
- Harness users: `?as=teacher` (admin), `?as=<any email>` (a student, or a guest who can join with a code). Its pretend Classroom has one class.
