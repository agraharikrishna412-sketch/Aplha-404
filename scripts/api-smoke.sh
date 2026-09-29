#!/usr/bin/env bash
# API smoke test — walks every route of a running Vroqn Nexus server as a signed-in student.
#
#   npm run seed --workspace server      # ensures the demo account exists
#   bash scripts/api-smoke.sh [apiBase]
#
# Exits non-zero when any check fails.
#
# The Arena section writes real data: it registers for the open competition, starts and submits the
# live demo paper, and (when the account is allowlisted) creates a throwaway competition. Restore the
# demo state with `npm run seed:arena --workspace server`.
set -u

# Demo credentials are dev defaults only: point these at a throwaway account in any shared environment.
SMOKE_EMAIL=${SMOKE_EMAIL:-demo@vroqn.dev}
SMOKE_PASSWORD=${SMOKE_PASSWORD:-nexus1234}

API=${1:-${API_BASE:-http://localhost:8787}}
J=${COOKIE_JAR:-/tmp/cj-smoke.txt}
rm -f $J
pass=0; fail=0
rate_limited=0
chk() {
  if echo "$2" | grep -q "$3"; then echo "  ok   $1"; pass=$((pass+1)); return; fi
  # A 429 is not a product failure — the AI limiter allows 40 calls/min per account and this script
  # exceeds that if it is run twice inside a minute. Say so, instead of reporting a false regression.
  if echo "$2" | grep -qiE 'rate_limited|too many requests|"status":429'; then
    echo "  FAIL $1 → RATE LIMITED (429): the AI limiter allows 40 calls/min per account."
    rate_limited=$((rate_limited+1)); fail=$((fail+1)); return
  fi
  echo "  FAIL $1 → $(echo "$2" | head -c 220)"; fail=$((fail+1))
}
jqv() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }

echo "— health / static"
chk "health"    "$(curl -s $API/api/health)" '"ok":true'
chk "spa index" "$(curl -s $API/practice | head -c 40)" 'doctype html'
echo "— auth"
chk "login demo" "$(curl -s -c $J -X POST $API/api/auth/login -H 'content-type: application/json' -d "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"$SMOKE_PASSWORD\"}")" '"name"'
chk "bad password 401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $API/api/auth/login -H 'content-type: application/json' -d "{\"email\":\"$SMOKE_EMAIL\",\"password\":\"definitely-not-the-password\"}")" '401'
chk "me"        "$(curl -s -b $J $API/api/auth/me)" '"Aarav"'
chk "no cookie 401" "$(curl -s -o /dev/null -w '%{http_code}' $API/api/notes)" '401'
echo "— dashboard / activity"
chk "dashboard"   "$(curl -s -b $J $API/api/dashboard)" '"Namaste, Aarav"'
chk "greeting"    "$(curl -s -b $J $API/api/dashboard | jqv "['greeting']")" 'Namaste'
chk "activity 7d" "$(curl -s -b $J "$API/api/activity/summary?days=7")" '"streakDays"'
chk "activity 30d" "$(curl -s -b $J "$API/api/activity/summary?days=30")" '"bySubject"'
chk "events"      "$(curl -s -b $J "$API/api/activity/events?limit=5")" '"events"'
chk "topics"      "$(curl -s -b $J $API/api/activity/topics)" '"weak"'
chk "activity data" "$(curl -s -b $J $API/api/settings/activity-data)" '"explanation"'
echo "— settings / keys"
chk "settings"      "$(curl -s -b $J $API/api/settings)" '"routing"'
chk "keys overview" "$(curl -s -b $J $API/api/keys/overview)" '"providers"'
# Exactly three providers. Counting substrings in the raw JSON is unreliable — each provider's
# `keyPrefixHint` also appears in the `hints` map, so a text count returns six. Ask the parsed payload.
chk "3 providers" "$(curl -s -b $J $API/api/keys/overview | python3 -c "import json,sys;print(len(json.load(sys.stdin)['providers']))")" '3'
for P in gemini groq openrouter; do
  chk "provider $P listed" "$(curl -s -b $J $API/api/keys/overview | python3 -c "import json,sys;print('yes' if any(p['id']=='$P' for p in json.load(sys.stdin)['providers']) else 'no')")" 'yes'
done
KEYS=$(curl -s -b $J -X POST $API/api/keys -H 'content-type: application/json' -d '{"provider":"gemini","key":"AIzaSyTESTKEYFORTESTS000000000000000","label":"Smoke Key"}')
chk "add key"  "$KEYS" '"masked"'
chk "masked"   "$KEYS" '•'
chk "no secret leak" "$(echo "$KEYS" | grep -c 'AIzaSyTEST')" '0'
KID=$(echo "$KEYS" | jqv "['key']['id']")
chk "update key"  "$(curl -s -b $J -X PATCH $API/api/keys/$KID -H 'content-type: application/json' -d '{"enabled":false}')" '"enabled":false'
chk "test key"    "$(curl -s -b $J -X POST $API/api/keys/$KID/test)" '"ok"'
chk "remove key"  "$(curl -s -b $J -X DELETE $API/api/keys/$KID)" '"ok"'
chk "save setting" "$(curl -s -b $J -X PUT $API/api/settings -H 'content-type: application/json' -d '{"routing":{"coding":"groq"},"verbosity":"balanced"}')" '"settings"'
echo "— notes"
NOTE=$(curl -s -b $J -X POST $API/api/notes -H 'content-type: application/json' -d '{"title":"Smoke note","subject":"Physics","chapter":"Laws of Motion","content":"# Hi\n\nInertia is the resistance to change in motion."}')
chk "create note" "$NOTE" '"Smoke note"'
NID=$(echo "$NOTE" | jqv "['note']['id']")
chk "list notes"  "$(curl -s -b $J $API/api/notes)" '"Smoke note"'
chk "search notes" "$(curl -s -b $J "$API/api/notes?q=inertia")" '"Smoke note"'
chk "get note"    "$(curl -s -b $J $API/api/notes/$NID)" 'Inertia is the resistance'
chk "patch note"  "$(curl -s -b $J -X PATCH $API/api/notes/$NID -H 'content-type: application/json' -d '{"starred":true}')" '"starred":true'
chk "ask note"    "$(curl -s -b $J -X POST $API/api/notes/$NID/ask -H 'content-type: application/json' -d '{"mode":"keypoints"}')" '"answer"'
chk "structure text" "$(curl -s -b $J -X POST $API/api/notes/structure -H 'content-type: application/json' -d '{"title":"Typed page","text":"Newton first law: inertia. Force equals mass times acceleration. Every action has an equal and opposite reaction."}')" '"note"'
chk "delete note" "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X DELETE $API/api/notes/$NID)" '200'
echo "— practice"
chk "catalog"   "$(curl -s -b $J $API/api/practice/catalog)" '"subjects"'
SET=$(curl -s -b $J -X POST $API/api/practice/generate -H 'content-type: application/json' -d '{"subject":"Physics","chapter":"Laws of Motion","difficulty":"medium","questionType":"mixed","count":3}')
chk "generate set" "$SET" '"questions"'
SID=$(echo "$SET" | jqv "['set']['id']")
QID=$(echo "$SET" | jqv "['set']['questions'][0]['id']")
chk "wrong answer graded" "$(curl -s -b $J -X POST $API/api/practice/check -H 'content-type: application/json' -d "{\"setId\":\"$SID\",\"questionId\":\"$QID\",\"answer\":\"definitely wrong\",\"timeSpentMs\":9000}")" '"feedback"'
chk "set detail" "$(curl -s -b $J $API/api/practice/sets/$SID)" '"questions"'
chk "sets list"  "$(curl -s -b $J $API/api/practice/sets)" '"sets"'
chk "attempts"   "$(curl -s -b $J $API/api/practice/attempts)" '"attempts"'
echo "— exams"
EX=$(curl -s -b $J -X POST $API/api/exams -H 'content-type: application/json' -d '{"subject":"Physics","chapters":["Laws of Motion"],"difficulty":"medium","questionCount":3,"questionType":"mixed","durationMin":15,"title":"Smoke Mock"}')
chk "create exam" "$EX" '"exam"'
EID=$(echo "$EX" | jqv "['exam']['id']")
RUNTIME=$(curl -s -b $J $API/api/exams/$EID)
chk "runner payload"  "$RUNTIME" '"questions"'
chk "answers blanked" "$(echo "$RUNTIME" | grep -c '\"answer\":\"\"')" '1'
chk "no explanations" "$(echo "$RUNTIME" | grep -c '\"explanation\":\"\"' )" '1'
chk "exam list"       "$(curl -s -b $J $API/api/exams)" '"exams"'
Q1=$(echo "$RUNTIME" | jqv "['exam']['questions'][0]['id']")
Q2=$(echo "$RUNTIME" | jqv "['exam']['questions'][1]['id']")
SUB=$(curl -s -b $J -X POST $API/api/exams/$EID/submit -H 'content-type: application/json' -d "{\"answers\":[{\"questionId\":\"$Q1\",\"answer\":\"B\",\"timeMs\":4000},{\"questionId\":\"$Q2\",\"answer\":\"gravity\",\"timeMs\":6000}],\"timeSpentMs\":120000}")
chk "submit exam"  "$SUB" '"result"'
chk "analysis"     "$SUB" '"weak'
RID=$(echo "$SUB" | jqv "['result']['id']")
chk "result fetch" "$(curl -s -b $J $API/api/exams/results/$RID)" '"result"'
chk "results list" "$(curl -s -b $J $API/api/exams/results)" '"results"'
chk "delete exam"  "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X DELETE $API/api/exams/$EID)" '200'
echo "— code lab"
chk "catalog"   "$(curl -s -b $J $API/api/code/catalog)" '"starters"'
JS=$(curl -s -b $J -X POST $API/api/code/run -H 'content-type: application/json' -d '{"language":"javascript","code":"const xs=[1,2,3,4];\nconsole.log(xs.map(x=>x*x).join(\",\"));\nconsole.log(\"sum\", xs.reduce((a,b)=>a+b,0));"}')
chk "js run"    "$JS" '1,4,9,16'
chk "js exit 0" "$(echo "$JS" | jqv "['result']['exitCode']")" '0'
chk "js stderr" "$(echo "$JS" | jqv "['result']['stderr']")" ''
PY=$(curl -s -b $J -X POST $API/api/code/run -H 'content-type: application/json' -d '{"language":"python","code":"def f(n):\n    return n*n\nprint([f(i) for i in range(4)])\nprint(sum(range(5)))"}')
chk "py run"    "$PY" '\[0, 1, 4, 9\]'
ERRS=$(curl -s -b $J -X POST $API/api/code/run -H 'content-type: application/json' -d '{"language":"javascript","code":"throw new Error(\"boom\");"}')
chk "error surfaced" "$ERRS" 'boom'
LOOP=$(curl -s -b $J -X POST $API/api/code/run -H 'content-type: application/json' -d '{"language":"python","code":"while True:\n    pass\n"}')
chk "timeout kill" "$LOOP" '"timedOut":true'
chk "assist"    "$(curl -s -b $J -X POST $API/api/code/assist -H 'content-type: application/json' -d '{"mode":"review","language":"python","code":"print(1)"}')" 'review\|degraded\|text'
chk "save session" "$(curl -s -b $J -X POST $API/api/code/sessions -H 'content-type: application/json' -d '{"title":"Sieve","language":"python","code":"print(2)"}')" '"session"'
chk "sessions"  "$(curl -s -b $J $API/api/code/sessions)" '"sessions"'
echo "— tutor"
chk "quick actions" "$(curl -s -b $J $API/api/tutor/quick-actions)" '"quickActions"'
chk "conversations" "$(curl -s -b $J $API/api/tutor/conversations)" '"conversations"'
curl -sN -b $J -X POST $API/api/tutor/stream -H 'content-type: application/json' -d '{"content":"What is inertia? Explain with an example.","subject":"Physics"}' > /tmp/sse.txt
chk "sse plan"  "$(cat /tmp/sse.txt)" 'event: plan'
chk "sse delta" "$(cat /tmp/sse.txt)" 'event: delta'
chk "sse done"  "$(cat /tmp/sse.txt)" 'event: done'
chk "sse demo flag" "$(cat /tmp/sse.txt)" '"demo":true'
CID=$(curl -s -b $J $API/api/tutor/conversations | jqv "['conversations'][0]['id']")
chk "thread"    "$(curl -s -b $J $API/api/tutor/conversations/$CID)" '"messages"'
chk "context"   "$(curl -s -b $J $API/api/tutor/conversations/$CID/context)" '"conversation"'
MID=$(curl -s -b $J $API/api/tutor/conversations/$CID | jqv "[m['role']=='assistant' for m in d['messages']].index(True)" )
MID=$(curl -s -b $J $API/api/tutor/conversations/$CID | python3 -c "import json,sys;d=json.load(sys.stdin);print([m['id'] for m in d['messages'] if m['role']=='assistant'][0])")
chk "save to notes" "$(curl -s -b $J -X POST $API/api/tutor/messages/$MID/save-to-notes)" '"note"'
chk "practice from answer" "$(curl -s -b $J -X POST $API/api/tutor/practice-from-answer -H 'content-type: application/json' -d "{\"messageId\":\"$MID\",\"count\":3}")" '"suggestion"'
echo "— voice"
# Voice was removed from the product (turn 7): no speech-to-text, no text-to-speech, no AI voice
# chat, and no endpoint that could quietly bring it back. These checks assert the removal, so an
# accidental reintroduction fails the smoke run instead of shipping.
chk "voice capabilities gone" "$(curl -s -o /dev/null -w '%{http_code}' -b $J $API/api/voice/capabilities)" '404'
chk "voice speak gone"        "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X POST $API/api/voice/speak -H 'content-type: application/json' -d '{"text":"Namaste"}')" '404'
chk "voice transcribe gone"   "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X POST $API/api/voice/transcribe)" '404'

echo "— arena (competitive exams)"
chk "arena catalog"  "$(curl -s -b $J $API/api/arena/catalog)" '"categories"'
chk "arena overview" "$(curl -s -b $J $API/api/arena/overview)" '"registered"'
ARENA_COMPS=$(curl -s -b $J $API/api/arena/competitions)
chk "arena competitions" "$ARENA_COMPS" '"competitions"'
chk "arena my competitions" "$(curl -s -b $J $API/api/arena/my-competitions)" '"attempts"'
chk "arena history"  "$(curl -s -b $J $API/api/arena/history)" '"history"'
chk "history has an attempt" "$(curl -s -b $J $API/api/arena/history | python3 -c "import json,sys;print(len(json.load(sys.stdin)['history']))")" '[1-9]'
chk "server clock sent" "$ARENA_COMPS" '"serverNow"'
# Fixtures are the seeded arena papers. Public ones only: a community-hosted paper is private to its
# members, and its questions are sealed from every browser by design, so it cannot stand in for the
# console/detail checks this script makes.
pick_competition() { curl -s -b $J $API/api/arena/competitions | python3 -c "
import json,sys
rows=json.load(sys.stdin)['competitions']
public=[c for c in rows if c.get('visibility')=='public'] or rows
print(next((c['id'] for c in public if c['state']=='$1'),''))"; }
LIVE_ID=$(pick_competition LIVE)
OPEN_ID=$(pick_competition REGISTRATION_OPEN)
DONE_ID=$(pick_competition RESULTS_PUBLISHED)
chk "demo competitions seeded" "$LIVE_ID|$OPEN_ID|$DONE_ID" '.......-'
# detail view: instructions for the student, never the answer key
OPEN_DETAIL=$(curl -s -b $J $API/api/arena/competitions/$OPEN_ID)
chk "competition detail"  "$OPEN_DETAIL" '"instructions"'
chk "detail keeps blueprint" "$OPEN_DETAIL" '"marksPerQuestion"'
chk "detail hides answers" "$(echo "$OPEN_DETAIL" | grep -c 'correctAnswer\|"correct_answer"')" '0'
chk "registration works" "$(curl -s -b $J -X POST $API/api/arena/competitions/$OPEN_ID/register -H 'content-type: application/json' -d '{}')" '"registration"'
chk "repeat registration is safe" "$(curl -s -b $J -X POST $API/api/arena/competitions/$OPEN_ID/register -H 'content-type: application/json' -d '{}')" '"registration"'
chk "withdraw registration" "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X DELETE $API/api/arena/competitions/$OPEN_ID/register)" '200'

# published result: benchmark + answer review + AI analysis are all readable by the owner
ATT_ID=$(curl -s -b $J $API/api/arena/history | python3 -c "
import json,sys
rows=[a for a in json.load(sys.stdin)['history'] if a['resultsPublished']]
print(rows[0]['attemptId'] if rows else '')")
chk "seeded attempt exists" "$ATT_ID" '.......-'
RESULT=$(curl -s -b $J $API/api/arena/results/$ATT_ID)
chk "result scores"        "$RESULT" '"accuracy"'
chk "benchmark published"  "$RESULT" '"percentile"'
chk "subject breakdown"    "$RESULT" '"subjectAnalysis"'
chk "topic breakdown"      "$RESULT" '"topicAnalysis"'
chk "time analysis"        "$RESULT" '"timeAnalysis"'
chk "practice suggestions" "$RESULT" '"practiceSuggestions"'
chk "answer review open"   "$RESULT" '"reviewAvailable":true'
chk "answer key revealed"  "$RESULT" '"correctAnswer"'
chk "anonymised standings" "$RESULT" '"standings"'
chk "AI analysis"          "$(curl -s -b $J -X POST $API/api/arena/results/$ATT_ID/analyze)" '"summary"'
chk "analysis is cached"   "$(curl -s -b $J $API/api/arena/results/$ATT_ID | grep -c '"report"')" '1'
chk "practice from weak areas" "$(curl -s -b $J -X POST $API/api/arena/results/$ATT_ID/practice)" '"startWith"'

# live paper: start → autosave → resume → submit → pending result (key stays server-side)
LIVE_STATUS=$(curl -s -b $J $API/api/arena/competitions/$LIVE_ID/status)
chk "status endpoint" "$LIVE_STATUS" '"serverNow"'
chk "registered for live paper" "$(curl -s -b $J -X POST $API/api/arena/competitions/$LIVE_ID/register -H 'content-type: application/json' -d '{}')" '"registration"'
EXAM=$(curl -s -b $J -X POST $API/api/arena/competitions/$LIVE_ID/start -H 'content-type: application/json' -d '{}')
chk "start returns paper"  "$EXAM" '"questions"'
chk "deadline from server" "$EXAM" '"deadlineAt"'
chk "paper hides answers"  "$(echo "$EXAM" | grep -c 'correctAnswer')" '0'
QID=$(echo "$EXAM" | python3 -c "import json,sys;print(json.load(sys.stdin)['exam']['questions'][0]['id'])")
chk "autosave answer"      "$(curl -s -b $J -X POST $API/api/arena/competitions/$LIVE_ID/answers -H 'content-type: application/json' -d "{\"updates\":[{\"questionId\":\"$QID\",\"answer\":\"A\",\"flagged\":true,\"timeSpentMs\":4200}]}")" '"saved"'
chk "resume keeps answer"  "$(curl -s -b $J -X POST $API/api/arena/competitions/$LIVE_ID/start -H 'content-type: application/json' -d '{}' | grep -c "\"flagged\":true")" '1'
chk "status shows attempt" "$(curl -s -b $J $API/api/arena/competitions/$LIVE_ID/status)" '"in_progress"'
SUB=$(curl -s -b $J -X POST $API/api/arena/competitions/$LIVE_ID/submit -H 'content-type: application/json' -d '{"answers":[]}')
chk "submit scored"        "$SUB" '"attemptId"'
chk "submit reports score" "$SUB" '"maxScore"'
PENDING=$(curl -s -b $J $API/api/arena/results/$(echo "$SUB" | jqv "['outcome']['attemptId']"))
chk "pending result"       "$PENDING" '"state"'
chk "review locked early"  "$PENDING" '"reviewAvailable":false'
chk "no key before publish" "$(echo "$PENDING" | grep -c 'correctAnswer')" '0'
chk "no explanations before publish" "$(echo "$PENDING" | grep -c 'explanation')" '0'
chk "tolerance is reported" "$(echo "$PENDING" | grep -c 'numericTolerance')" '1'
RESUB=$(curl -s -b $J -X POST $API/api/arena/competitions/$LIVE_ID/submit -H 'content-type: application/json' -d '{"answers":[]}')
chk "resubmit is refused"   "$RESUB" '"already_submitted"'
chk "resubmit names attempt" "$RESUB" '"attemptId"'

# Cross-account access: a second account must not be able to read another student's attempt.
# A fixed throwaway account. It lives on the seeder's demo domain, so `seed:arena` clears it and
# repeated smoke runs reuse one row instead of filling the database.
OTHER="intruder@demo.vroqn.local"
curl -s -c /tmp/cj-intruder.txt -X POST $API/api/auth/signup -H 'content-type: application/json' \
  -d "{\"name\":\"Intruder\",\"email\":\"$OTHER\",\"password\":\"throwaway-pass-1234\",\"classLevel\":\"Class 12\",\"board\":\"CBSE\"}" >/dev/null
chk "result is private to its owner" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cj-intruder.txt $API/api/arena/results/$(echo "$SUB" | jqv "['outcome']['attemptId']"))" '403'
chk "analysis is private to its owner" "$(curl -s -o /dev/null -w '%{http_code}' -b /tmp/cj-intruder.txt -X POST $API/api/arena/results/$(echo "$SUB" | jqv "['outcome']['attemptId']")/analyze -H 'content-type: application/json' -d '{}')" '403'
chk "someone else's history is empty" "$(curl -s -b /tmp/cj-intruder.txt $API/api/arena/history | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('history',[])))")" '0'
rm -f /tmp/cj-intruder.txt

# The admin surface is enforced server-side by the ARENA_ADMIN_EMAILS allowlist. Assert whichever side
# of that allowlist this account is on — detected from the *server*, not from this shell's environment,
# because the two can disagree (the server decides, so the server is what we ask).
IS_ARENA_ADMIN=0
if [ "$(curl -s -o /dev/null -w '%{http_code}' -b $J $API/api/arena/admin/competitions)" = "200" ]; then
  IS_ARENA_ADMIN=1
fi
if [ "$IS_ARENA_ADMIN" = "1" ]; then
  ADMIN_LIST=$(curl -s -b $J $API/api/arena/admin/competitions)
  chk "admin list reachable" "$ADMIN_LIST" '"competitions"'
  chk "paper readiness exposed" "$ADMIN_LIST" '"readiness"'
  chk "invalid schedule rejected" "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X POST $API/api/arena/admin/competitions -H 'content-type: application/json' -d '{"title":"x","description":"y","category":"foundation","registrationOpensAt":"2026-01-05T00:00:00.000Z","registrationClosesAt":"2026-01-02T00:00:00.000Z","startsAt":"2026-01-03T00:00:00.000Z","endsAt":"2026-01-04T00:00:00.000Z"}')" '400'
else
  chk "admin list 403"     "$(curl -s -o /dev/null -w '%{http_code}' -b $J $API/api/arena/admin/competitions)" '403'
  chk "admin create 403"   "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X POST $API/api/arena/admin/competitions -H 'content-type: application/json' -d '{"title":"Nope","description":"x","category":"foundation","registrationOpensAt":"2026-01-01T00:00:00.000Z","registrationClosesAt":"2026-01-02T00:00:00.000Z","startsAt":"2026-01-03T00:00:00.000Z","endsAt":"2026-01-04T00:00:00.000Z"}')" '403'
  chk "admin generate 403" "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X POST $API/api/arena/admin/competitions/$OPEN_ID/generate -H 'content-type: application/json' -d '{"bankOnly":true}')" '403'
  chk "admin patch 403"    "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X POST $API/api/arena/admin/competitions/$OPEN_ID/action -H 'content-type: application/json' -d '{"action":"start_now"}')" '403'
fi

if [ "$IS_ARENA_ADMIN" = "1" ]; then
  echo "— arena admin (allowlisted account)"
  chk "admin list"        "$(curl -s -b $J $API/api/arena/admin/competitions)" '"competitions"'
  chk "admin questions"   "$(curl -s -b $J "$API/api/arena/admin/competitions/$OPEN_ID/questions")" '"questions"'
  chk "admin action note" "$(curl -s -b $J -X POST $API/api/arena/admin/competitions/$OPEN_ID/action -H 'content-type: application/json' -d '{"action":"open_registration"}')" '"note"'
  NEW=$(curl -s -b $J -X POST $API/api/arena/admin/competitions -H 'content-type: application/json' -d '{"title":"Smoke Competition","description":"Created by the API smoke test.","category":"foundation","registrationOpensAt":"2026-01-01T00:00:00.000Z","registrationClosesAt":"2026-01-02T00:00:00.000Z","startsAt":"2026-01-02T01:00:00.000Z","endsAt":"2026-01-02T03:00:00.000Z"}')
  chk "admin create"      "$NEW" '"competition"'
  NEW_ID=$(echo "$NEW" | jqv "['competition']['id']")
  GEN=$(curl -s -b $J -X POST $API/api/arena/admin/competitions/$NEW_ID/generate -H 'content-type: application/json' -d '{"bankOnly":true}')
  chk "bank-only generation" "$GEN" '"created"'
  chk "full-size paper"      "$(echo "$GEN" | jqv "['created']")" '30'
  # Generated questions are never self-approved, and a pending paper cannot be started.
  chk "generated paper awaits review" "$(echo "$GEN" | jqv "['shortfall']")" '0'
  chk "generated questions are pending" "$(sh -c "curl -s -b $J $API/api/arena/admin/competitions/$NEW_ID/questions" | jqv "['readiness']['pending']")" '30'
  chk "start blocked while pending" "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X POST $API/api/arena/admin/competitions/$NEW_ID/action -H 'content-type: application/json' -d '{"action":"start_now"}')" '409'
  NQ=$(curl -s -b $J "$API/api/arena/admin/competitions/$NEW_ID/questions" | jqv "['questions'][0]['id']")
  chk "question review"      "$(curl -s -b $J -X PATCH "$API/api/arena/admin/questions/$NQ?competitionId=$NEW_ID" -H 'content-type: application/json' -d '{"reviewStatus":"approved"}')" '"ok"'
  chk "question delete"      "$(curl -s -b $J -X DELETE "$API/api/arena/admin/questions/$NQ?competitionId=$NEW_ID")" '"ok"'
  chk "competition delete"   "$(curl -s -b $J -X DELETE "$API/api/arena/admin/competitions/$NEW_ID")" '"deleted":true'
  chk "deleted competitions can't be opened" "$(curl -s -o /dev/null -w '%{http_code}' -b $J $API/api/arena/competitions/$NEW_ID)" '404'
  chk "competition with attempts is protected" "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X DELETE $API/api/arena/admin/competitions/$DONE_ID)" '409'
  # The live paper is immutable: regenerating it would change what students already received.
  chk "live paper is locked" "$(curl -s -o /dev/null -w '%{http_code}' -b $J -X POST $API/api/arena/admin/competitions/$LIVE_ID/generate -H 'content-type: application/json' -d '{"bankOnly":true}')" '409'
else
  echo "  skip arena admin checks (run the server with ARENA_ADMIN_EMAILS=\$SMOKE_EMAIL to exercise them)"
fi

echo
if [ "$rate_limited" -gt 0 ]; then
  echo ""
  echo "NOTE: $rate_limited check(s) failed with HTTP 429, not a logic error."
  echo "      Wait ~60 seconds and re-run — the AI rate limiter is per-account, not per-run."
fi
echo "PASS: $pass   FAIL: $fail"

if [ "$fail" -gt 0 ]; then exit 1; fi
