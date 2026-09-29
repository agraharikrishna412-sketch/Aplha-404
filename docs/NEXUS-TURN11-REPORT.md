# Vroqn Nexus — Turn 11 report

Aapki teen baatein: homepage saaf karo, planet ke **saare** icons clickable banao (News wala chip → News khule), aur account/community delete ka option do. Teeno ho gaye — aur teeno me asli bug mile jo sirf naapne se pata chale.

---

## 1. Homepage saaf — aapki poori list hata di

Neeche ki **saari** cheezein Home se hat gayi hain:

| Hataya | Kahan hai ab |
| --- | --- |
| Your profile | **Profile** |
| Learning analytics (preview) | **Learning Analytics** |
| Start here (quick actions) | **AI · Practice · Mock Exam · Notes · Code Lab** |
| Everything in Vroqn (14 destinations) | header menu — saare 14 |
| Vroqn Communities | **Groups** |
| Today's Learning | **Learning Activity** |
| What to do next | **AI Tutor / Practice** |
| Your AI connections | **Settings → AI keys** |

Kuch delete nahi hua, sirf Home par clutter nahi rahega. Ab Home = **3D planet + search + top communities + news (+ Arena nudge)**.

Scan dono taraf check karta hai: menu me saare 14 destinations **hain**, aur Home par wo hataaye gaye sections **nahi hain**.

## 2. Planet: 14 icons, har ek clickable

Aapne kaha "planet me bahut saare icon ghum rahe hain, click karo to uska function chale". Ab **14 destinations** planet par hain, do rings me:

**Bahar ki ring (8) — jo student karta hai:**
`AI · Practice · News · Notes · Code Lab · Mock Exam · Arena · Groups`

**Andar ki ring (6) — jo student ka apna hai:**
`Messages · Profile · Analytics · Activity · Settings · Help`

Har chip ek **asli link** hai: News par click → News khulta hai. Code Lab → Code Lab. Messages → Messages. Scan yeh khud test karta hai: click karta hai aur dekhta hai ki URL wahi hai jo chip ne promise kiya.

### Planet bada + zyada realistic

* Box **300px (phone) / 470px (laptop)** — pehle se bada, aur orbit bhi (r=160 bahar, r=76 andar, ellipse 320×400).
* **Asli 3D depth:** 45° ka screen tilt + 1000px camera — saamne wala chip sach me bada, peeche wala chhota. Koi nakli `scale()` nahi.
* **Instrument dial** 48 ticks + sweep hand, **dust ring**, **glass sphere** with specular streak, aur ground shadow.

### Yahan asli bug tha (aur kaise pakda gaya)

Chips ek doosre par chadh rahe the. Sab 100x dekhne ke baad teen asli defects mile:

1. **Keyframe percentages galat thi** — 8 chips ke liye maine 0%, 45%, 90%… likh diya tha (0/45/90 ki jagah 0/12.5/25…). Poori orbit ek chhote se arc me semat gayi thi. Isi wajah se planet clump ho gaya tha.
2. **Dono rings alag speed par the** — inner ring 24s, outer 30s. Iska matlab relative angle har value se guzarta tha, aur jab inner chip outer chip ke "peeche" aata tha to **24px** door aa jaate the. Ab dono ring **ek hi speed, ek hi direction** me hain — clearance poore revolution me **31–51px** fix rehti hai (naapa hua, guess nahi).
3. **Dial distort ho gaya tha** — `scaleY(1.25)` ticks ko kheench deta tha. Ab har tick ellipse par **apne outward normal** ke saath place hota hai (component me ganit se).

Iske alawa: inner ring ke 6 chips closer hote hain, to unke **naam hover/focus par dikhte hain** — warna 14 naam ek doosre par chadh jaate. Icon + accessible name (screen reader/voice) hamesha kaam karte hain.

## 3. Account aur community delete

**Community delete** pehle se tha (**Groups → Manage → Delete community**, sirf owner ke liye, confirm ke saath).

**Account delete** naya bana hai — **Settings → Danger zone → Delete my account**:

* Pehle batata hai **exactly kya jayega**, aapke apne numbers me: *"Right now that is 20 notes, 20 AI conversations, 40 AI messages, 20 practice sets, 10 practice answers, 6 Arena entries, 10 Code Lab sessions, 154 activity records…"*
* Do confirmation maangta hai: **password** (chori hui session se account tabah na ho) aur **DELETE type karna** (ek galti se tap account khatam na kar de).
* **Guard:** agar aap aisi community ke owner ho jisme doosre students hain, delete **rok diya jaata hai** aur wo communities naam ke saath link ke saath dikh jaati hain — *"Hand it over or delete it first; nobody else should lose their group because one person left."* Jisme sirf aap ho, wo aapke saath chali jaati hai.
* Private chats **dono taraf** se delete hote hain (confirm screen par saaf likha hai).
* Sab kuch **ek transaction** me: ya poora delete, ya kuch bhi nahi. Aur transaction ke andar hi dobara gin kar check hota hai ki ek bhi row bacha nahi — fail ho to poora rollback.

**Iska test:** `server/test/account-deletion.test.ts` — 5 tests. Ek test poore schema ko walk karta hai, har us column ko dhoondta hai jo user ko point karta hai, aur fail ho jaata hai agar deletion plan us table ko cover na kare. **Usne do asli gaps pakde:** `dm_reactions` aur `arena_competitions` — dono ab handle hote hain (Arena paper jisme doosre registered hain, wo bhi block karta hai — bilkul community jaise).

## 4. Verification — sab is final build par

| Suite | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm test` | **167 / 0**, 43 suites (5 naye account-deletion tests) |
| `npm run smoke:api` | **124 / 0** |
| `npm run smoke:flows` | **66 / 0** |
| `npm run smoke:ui` | **44 screens / 0 failed / 0 runtime errors** |
| `npm run smoke:browser` | **33 / 0** |
| `npm run scan:site` | **117 / 0** |
| `npm run smoke:ownership` | **15 / 0** |
| `communities-check.mjs` | **106 / 0** |
| `private-chat-check.mjs` | **18 / 0** |

Scan me planet ke naye checks: saare **14 destinations chips par hain** · har chip asli link · **koi do chips confuse nahi ho sakte** (closest pair ≥ 26px) · hover/focus par orbit rukta hai · disc dabane par wahi screen khulti hai · reduced motion me poori drawing jam jaati hai (14 chips, 48 ticks).

## Honest limits

* Planet CSS 3D hai, WebGL/three.js nahi. Depth asli perspective projection se aati hai; koi lighting model ya cast shadow nahi.
* Inner ring ke labels hover/focus par dikhte hain (space ki wajah se) — icons aur screen-reader names hamesha available hain.
* Account delete karne ke baad wo email dobara signup kar sakta hai (naya account). Ye jaan-boojh kar hai: purana data wapas nahi aata.
* `api-smoke` / `smoke:flows` demo account se live Arena paper chalate hain — pehle `npm run seed:arena --workspace server` chalao.

## Chalane ke liye

```bash
npm install && npm run build && npm start          # http://localhost:8787
npm run seed --workspace server                     # demo student
npm run seed:arena --workspace server               # Arena papers
npm run seed:communities                            # starter communities
```
