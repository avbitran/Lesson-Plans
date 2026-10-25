# Online Tests (Google Apps Script)

A free online test system that runs entirely in your school Google account.

- **Students sign in with their school Google account.** No passwords to hand out. They open one link.
- **Read-aloud.** A 🔊 Listen button on every question, the instructions and reading passages, with a speed control. Choose the voice for each test: the free device voice, a **natural Google voice**, or your own **Chatterbox** voice server. Natural-voice audio is made once and saved in your Drive.
- **Voice answers.** Students can record a spoken answer to any question with 🎤. You listen to it while grading.
- **Per-student accommodations.** Read-aloud, voice answers, and extra time (+25% to +100%), set by you for each student, or read-aloud/voice answers for a whole test.
- **Bagrut-style questions.** Multiple choice with one correct answer or several ("Choose the TWO correct answers", marked per answer or all-or-nothing), **fill in the blanks** (several blanks per sentence, an optional word bank, typed or chosen from a drop-down), **matching**, short answers marked automatically, open answers, and reading passages. Hebrew and Arabic text is shown right-to-left automatically.
- **Create a test from a PDF or Word file with AI.** Give any AI chat (Claude, Gemini, ChatGPT) the PDF and the app's ready-made instructions, paste the reply back, and check the draft.
- **Submit and grade.** Answers save automatically. Multiple choice and short answers are marked for you, and anything uncertain is flagged "Check". You mark the rest, add comments, and return the test.
- **Exam mode.** Every time a student leaves the test (another tab, window or app) it's recorded with the time. After a number of warnings you choose, the test **pauses until you unlock it** or **submits itself**. Copy/paste is blocked.
- **👁 Student view.** See any test exactly as students do: the start screen, the questions, read-aloud and voice buttons, extra time, and (if you want) exam mode with its warnings and pause. Pick a specific student to see their accommodations, or see a student's home page from the Students page. Nothing is saved.
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
3. Set **Classes** (leave empty for all students) and set the status to **Open**, then **Save**. Use **👁 Student view** to see and hear it the way students will.
4. Give students the web app link (for example in Google Classroom). They see the test, press **Start**, and you watch from **Tests → (the test)**.

---

## The link for students

Send students the **Web app URL**, the same link you open yourself. It ends in `/exec`. To find it again: in the Apps Script editor, **Deploy → Manage deployments**, then copy the **Web app** URL. Don't send the editor's address or a link ending in `/dev`.

Students only get in if their school email is on the **Students** page. Anyone else sees "not on the class list".

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

**Matching.** Enter each item with its match. Students see the matches mixed up (the same order for everyone) and pick one for each item. You can add extra wrong choices.

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
5. In the app: **Students → Settings → Read-aloud voices**, paste the key and click **Save voices**.
6. In a test, choose **Google natural voice** and a voice name (the list has good English and Hebrew voices; any [Google voice name](https://cloud.google.com/text-to-speech/docs/list-voices-and-types) works).

### Chatterbox (your own voice server)

[Chatterbox](https://github.com/resemble-ai/chatterbox) is a free, open-source voice model that runs on your own computer (a graphics card helps a lot). The app talks to it through the OpenAI-style address `/v1/audio/speech`, which ready-made Chatterbox servers provide, for example [Chatterbox TTS API](https://github.com/travisvn/chatterbox-tts-api).

Google's servers make the audio, so they must be able to reach your Chatterbox server. A server that runs only on your computer (an address like `localhost:4123`) needs a public address:

1. Start your Chatterbox server.
2. Make a public address for it with a free tunnel, for example [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/): `cloudflared tunnel --url http://localhost:4123` prints an address like `https://something.trycloudflare.com`.
3. In the app: **Students → Settings → Read-aloud voices**, paste that address as the Chatterbox server address (and a key if your server needs one).
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

It **can't stop** a student opening another window. No website can. It **detects** leaving (tab switch, Alt-Tab, clicking another window, leaving full screen when available), warns the student, logs it for you with timestamps, and pauses or submits the test after the number of warnings you set.

For a complete lockdown on managed Chromebooks, ask your school's Google admin to open the app link in a locked kiosk/exam mode for your students. You don't need admin access for anything else here.

## Updating the app later

Paste the new `Code.gs`, save, then **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The link stays the same.

If an update needs a new permission (natural voices need permission to *connect to an external service*), Google asks once: in the editor choose **authorize** in the function list, click **▷ Run** and tick every box.

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

- `src/server/`: `Core.js` (test validation, auto-marking), `Api.js` (all routes; storage passed in), `Store.js` (Sheets tables, JSON split across cells), `Main.js` (`doGet`, `rpc`, identity, Drive, the Google and Chatterbox voice services).
- `src/client/`: the pages (plain JavaScript, hash routing), inlined into `Index.html` and embedded in `Code.gs` as `INDEX_HTML`.
- The page code is shipped base64-encoded and decoded by a small loader. Google rewrites inline scripts when it serves Apps Script pages, and the rewritten code can stop parsing ("Failed to execute 'write' on 'Document'"). `node test/harness.js` then `/google?as=teacher` loads the page with `document.write` in an iframe, the way Google's wrapper does.
- `recorder.html`: the pop-up recorder for GitHub Pages. It only talks to `*.googleusercontent.com` pages.
