'use strict';
// The role (Jake, 2026-11-03): "imagine your job is to turn me into Bond for a movie and I want to follow a method
// actor type" … "Don't just look at him like a man with skills. It's so much deeper" … "integrated into self hub as
// its own page, integrating the full bnd courses there, and ensuring there is plenty of guidance, reassurance, and
// inspiration along the way".
//
// The Andrew page's own words: the character's inside (ten forces, the shadow, the five-film arc, the method), the
// outside (costume, grooming, manner), what each Trinity BND course gives the character, the levels, reassurance for
// each state a course can be in, and the actor's notebook questions. The courses themselves and their progress come
// live from the Trinity Degree through Sentinel (routes/role.js); nothing here duplicates Trinity's curriculum.
// Paraphrase only: no quotations from the films or books.

const FORCES = [
  { id: 'approval', title: "He doesn't need your approval",
    body: "He's pleasant, often charming, but his sense of himself isn't up for a vote in every conversation. He doesn't fish for approval: no explaining himself, no talking himself up, no laughing at things that aren't funny. People sense very quickly who's asking for something and who isn't, and the one who isn't becomes the centre of the room.",
    shows: 'He lets silences sit, doesn\'t justify a decision, and can say no without a reason attached.',
    actor: "Notice the small bids for approval: the extra explanation, the \"if that makes sense\", the glance to see how a joke landed. Don't fight them. Just notice, and let one go unsaid today." },
  { id: 'worst', title: 'He has already accepted the worst case',
    body: "Bond lives close to danger and has made peace with it, which is why nothing in an ordinary room can threaten him. A man who has already faced the worst outcome isn't rattled by a hard conversation, a rude stranger or a deal going sideways. The Stoics practised this on purpose: picture the loss calmly beforehand, and when it comes it has no power.",
    shows: "He's calm when others are anxious, and the calm spreads.",
    actor: "Before anything that tightens your stomach today, take one quiet minute: what's the worst that happens, and could I live with it? Then go in having already survived it." },
  { id: 'calm', title: 'His calm is earned, not performed',
    body: "He's calm because he's competent. He's been trained and tested so often that most situations already have an answer in his body. Acted calm cracks under pressure; calm from having done the hard thing before doesn't. That's what the hard courses are really for: judo, first response, diving, poker. Pressure in small, mastered doses until the nervous system stops treating it as danger.",
    shows: 'He slows down when things go wrong. His voice drops instead of rising.',
    actor: 'When something goes wrong today, slow your breathing and your speech on purpose. Four counts in, hold four, out four, hold four. Every time under real pressure banks calm for the next.' },
  { id: 'outward', title: 'His attention points outward',
    body: "This is what makes him look effortless. He's almost never thinking about himself in a room. He's reading it: who's nervous, who decides, what's being left unsaid. Effort shows when a man watches himself. Bond watches everyone else, and people feel more seen by him than by anyone they meet that week.",
    shows: 'He remembers names and small details, and asks the second question.',
    actor: 'Before you walk into a room today, give yourself one thing to find out about the people in it. Hold it the whole time. You can\'t watch yourself and hunt for that at once.' },
  { id: 'withhold', title: 'He gives very little away',
    body: "He reveals almost nothing unless he chooses to. Curiosity is the itch we feel when we know there's something we don't know, so a man who tells you everything gives you nothing to wonder about, and a man who clearly has more to say and doesn't makes people lean in. Every word he doesn't say adds weight to the ones he does.",
    shows: 'Short answers to personal questions, with a slight smile. Stories when someone asks, never to fill a gap.',
    actor: 'Answer the question that was asked, and stop. Let them ask the follow-up.' },
  { id: 'warmth', title: 'Competence first, warmth by choice',
    body: "People judge everyone in seconds on two things: are you with me, and can you act on it. Bond reads as highly capable and holds his warmth back, so people are a little wary; they can't yet tell whose side he's on. Then he gives warmth to someone, and because it was held back it lands hard. That's the threatened-and-excited feeling you described.",
    shows: 'Polite and slightly cool with strangers; warm and direct with people who have earned it; never cold to anyone weaker.',
    actor: "Give real warmth today to someone who can't do anything for you: the boys, a server, the hired man. Andrew's warmth flows downward. People read it instantly." },
  { id: 'status', title: 'He plays status like an instrument',
    body: "Theatre teaches actors that every interaction is a quiet status exchange. High status isn't dominance; it's stillness: a still head, unhurried speech, comfortable eye contact. Low status is the fidgeting, the quick glances, the apologies. The real mastery is being able to drop status at will, to make fun of himself or let the other man win a point. Only a secure man can afford that.",
    shows: 'Head still when he talks. A slow turn toward whoever is speaking.',
    actor: 'Keep your head still today while you speak and while you listen. Strange for two days, then natural.' },
  { id: 'tastes', title: 'His tastes are decided, so he is free',
    body: "Fleming spends pages on what Bond eats, drinks and drives. It reads like snobbery and it's psychology: he decided his preferences once, properly, so he never deliberates in public and his attention stays on the room. Pleasure is also how he stays present. Few things, chosen well, fully enjoyed.",
    shows: 'The order comes out without hesitation. One true, specific thing said about it, only if asked.',
    actor: 'Choose fast today, and enjoy fully what you chose.' },
  { id: 'code', title: 'He serves something bigger than himself',
    body: "He has a duty and a code, and they put him above petty things: gossip, envy, small wins, being right. A man with a mission doesn't compete over the bill or the best story. In Craig's films the code becomes personal: it's about whom he'll protect.",
    shows: 'Small slights pass. He never needs to win the argument at the table.',
    actor: "Keep the mission in the back of your mind today: the land, Ashley and the boys, what you're building. It makes most of what happens in a room small." },
  { id: 'ease', title: 'Ease and danger at once',
    body: "The defining tension: completely relaxed and completely alert. Loose shoulders, slow movement, a joke, and underneath it a mind that has noticed everything and could act in a second. The ease makes people comfortable; the alertness underneath is the slight threat they can't name.",
    shows: 'Sitting back with eyes that miss nothing.',
    actor: 'At every door today: shoulders down, jaw loose, breathing low. Then let your eyes do the work.' },
];

const SHADOW = [
  ['Self-sufficiency', 'Lets no one close; ends every film alone', 'Self-sufficient in the world, open at home'],
  ['Withholding', 'Coldness; nobody really knows him', 'Reserved with strangers, fully known by Ashley'],
  ['Appetite', 'Drinks to numb', 'Pleasure in quality, never quantity'],
  ['Acceptance of risk', 'Recklessness', 'Calculated risk, because people depend on him'],
  ['Needs stakes', 'Slumps into boredom and gloom between missions', 'Builds his own stakes: the degree, the land, the next expedition'],
  ['Charm', 'Uses people', 'Charm used to make people feel good about themselves'],
];
const SHADOW_RULE = 'The coolness that works on strangers never reaches the kitchen table. If Ashley or the boys get the withheld version of you, the character has gone wrong.';

const ARC = [
  ['Casino Royale', 'A brilliant, arrogant blunt instrument. He lowers the armour for the first time, is betrayed, and puts it back on harder.'],
  ['Quantum of Solace', 'Grief turned into rage and work. Composure as a cover.'],
  ['Skyfall', 'Older, broken down, home to the house where his parents died. The armour gets examined.'],
  ['Spectre', 'The past comes back, and for the first time he chooses a life over the job.'],
  ['No Time to Die', 'A father. At last someone who lets himself be loved, and everything he is goes to protecting them.'],
];
const ARC_INSIGHT = "Bond never got to live the ending. You're playing the man from the last film, alive: the same competence and presence, given a home to protect.";

const METHOD = [
  ['Super-objective', 'What the character wants above everything, driving every scene', 'Yours is in the notebook below. Rewrite it until it\'s true.'],
  ['Scene objective', 'What he wants from this scene, always about the other people', 'Before each room: one thing to find out about them.'],
  ['The magic "if"', 'What would I do if I were him, here?', 'At the parts counter, the sale barn, the school concert.'],
  ['Given circumstances', 'The facts the character lives in', 'Your real life, unchanged. He is not somewhere else.'],
  ['Subtext', 'What is meant under what is said', 'Say less, mean more. Let a look finish the sentence.'],
  ['Sense memory', 'Bringing a real feeling into a scene', 'Remember the calmest you have ever been under real pressure, and carry that body into the next hard room.'],
];

const LOOK = {
  costume: [
    ['Ext. yard, day', 'A waxed cotton jacket, a heavy work shirt or merino, dark straight jeans that fit, oiled leather boots, a wool toque in winter.'],
    ['Int. town, the elevator', 'The same boots, an Oxford or chambray shirt, a navy crewneck or quilted vest, clean jeans. The difference from the yard is a clean collar.'],
    ['Int. dinner out', 'A navy unstructured blazer, a white or light blue shirt with no tie, grey wool trousers or dark jeans, brown suede chukkas.'],
    ['Ext. summer', 'A navy knit polo, chinos, desert boots or leather sneakers, a field watch.'],
    ['Wedding or funeral', 'One navy suit tailored to you, a charcoal tie, a white shirt, black cap-toes.'],
    ['On the body', 'One good watch worn everywhere, a plain belt that matches the boots, sunglasses that suit your face, a good knife.'],
  ],
  rule: 'Fit first. One notch better than the room, never two. Everything worn and looked after.',
  grooming: [
    ['Hair', 'Short and neat on the sides, a little length on top, cut every three to four weeks by one barber.'],
    ['Face', 'Clean-shaven, or short even stubble trimmed every two or three days with a clean neckline. Never in between.'],
    ['Skin', 'Cleanser and an SPF moisturiser every morning; lip balm in the truck. Wind and sun are the enemy on a farm.'],
    ['Teeth', 'A cleaning every six months, whitening once if they need it, a night guard if you grind.'],
    ['Hands', 'Nails short and clean. Work hands are fine; dirty nails aren\'t.'],
    ['Scent', 'One cologne, lightly, evenings only. It becomes his.'],
  ],
  manner: [
    ['Entering', 'Stop a second inside the door, take in the room, then go to the person you came for.'],
    ['The pause', 'A breath before you answer. Everything sounds considered.'],
    ['Voice', 'Slower and lower than feels natural; sentences end down, not up.'],
    ['Eyes', 'Hold eye contact to the end of their sentence, then look away on your own terms.'],
    ['Phone', 'Face down or in the pocket whenever someone is talking to you.'],
    ['Hands', 'Still, out of the pockets. A drink held low and steady.'],
  ],
};

// What each BND course gives the character. Trinity owns the course; this is only its place in Andrew.
const COURSE_ROLE = {
  'BND-101': 'The body the role is written for: capable, lean, never built for a mirror. Everything else stands on it.',
  'BND-102': 'A place to train that the winter can\'t take away. The first thing he builds with his own hands for the role.',
  'BND-103': 'At home under water: calm where most people panic. Composure learned at depth carries to every room.',
  'BND-104': 'Thrown, and up again, three times a week. The quiet physical confidence people feel before he says a word.',
  'BND-105': 'A classified shot and a job done properly on his own land. Competence with consequences, held lightly.',
  'BND-106': 'The mountains, safely: a man who is useful on a rope, not a passenger.',
  'BND-107': 'The one who acts when someone goes down. The most Bond thing a farmer can be.',
  'BND-108': 'Spanish spoken with a rancher in Guanacaste. Being at ease in another language is a kind of presence.',
  'BND-109': 'Twelve dishes, eight cocktails, four dinners at his own table. Feeding people well, without fuss.',
  'BND-110': 'A room that listens. Not a performer: a man people are glad stood up.',
  'BND-111': 'Clothes as a system, anchored by one commissioned garment. Dressed right without thinking about it.',
  'BND-112': 'An instrument played for people who didn\'t have to listen. It changes a room at night.',
  'BND-113': 'Seeing persuasion coming, and never needing to manipulate. The calm of a man who can\'t be worked.',
  'BND-114': 'A face that gives nothing away with money on the table. Decisions under uncertainty, made coolly.',
  'BND-115': 'The first expedition: everything Level 1 built, tested together in the field.',
  'BND-116': 'Real rock, from the gym wall to multi-pitch in Squamish. Fear managed on a rope.',
  'BND-117': 'At home in the boreal: fire in any weather, meat he hunted in the freezer. Skyfall\'s Scotland, in Saskatchewan.',
  'BND-118': 'A canoe that goes north every year. Quiet competence on moving water.',
  'BND-119': 'A horseman on his own ranch horse at every gather. The oldest kind of presence there is.',
  'BND-120': 'The winter traveller: out on frozen country only reachable when it freezes, and able to fix the machine there.',
  'BND-121': 'Piano, examined. Discipline you can hear, and something to play when the house is quiet.',
  'BND-201': 'The first overhead environment. Gas planned and defended; nerves that hold where there is no straight way up.',
  'BND-202': 'A rare useful skill on any expedition: eyes in the air.',
  'BND-203': 'Driving that\'s calm at speed and in trouble. The car chase, done safely.',
  'BND-204': 'Precision at distance: the first shot accounted for, cold.',
  'BND-205': 'Alpine terrain without an instructor: his own judgement setting the margins.',
  'BND-206': 'Physical confidence in a social setting. The most underrated skill in the programme, and pure Bond.',
  'BND-207': 'Wine, properly: to order well and say one true thing about it.',
  'BND-208': 'Negotiation applied live. Getting what he came for, and leaving them glad.',
  'BND-209': 'Fewer, better things: every context covered by a capsule that\'s his.',
  'BND-210': 'An international expedition with a question attached.',
  'BND-211': 'Seventy-two hours alone in the boreal winter on a pocket kit. After that, no room is hard.',
  'BND-212': 'A dual-sport bike he rides and keeps himself, pavement, gravel and trail.',
  'BND-213': 'A skipper with his own boat: the lake, the dive boat, the radio.',
  'BND-214': 'The truck as an expedition vehicle that can go remote and get itself out.',
  'BND-301': 'A pilot. The largest single widening of where he can go.',
  'BND-302': 'Floats and tailwheel: remote water and gravel strips.',
  'BND-303': 'Flying in cloud: the aircraft as a tool, not a fair-weather pleasure.',
  'BND-304': 'Caves reached by qualification: the unmapped places.',
  'BND-305': 'The stage now raising money: the voice used for something real.',
  'BND-306': 'A network turned into a circle of people who trust each other.',
  'BND-307': 'His signature decided once: silhouette, palette, watch, drink, scent, pen. Then simply kept.',
  'BND-308': 'The flagship expedition: remote, original, his own.',
  'BND-401': 'Asked, not organising: invited onto other people\'s expeditions for what he brings.',
  'BND-402': 'Something that wasn\'t known before he went.',
  'BND-403': 'The rooms of explorers: membership earned.',
  'BND-404': 'His work in print, nationally, because of something he did.',
  'BND-501': 'The standing life: the character is simply who he is.',
};
const LEVELS = {
  1: ['Building the man', 'The body, the basics and the first certificates. Most of what people will feel in a room is laid down here.'],
  2: ['Proving it in the field', 'The same skills taken further and used for real, without an instructor setting the margins.'],
  3: ['Range', 'Flying, caves and the signature. The world gets wider and the character gets distinct.'],
  4: ['Recognised', 'Other people asking for him.'],
  5: ['The standing life', 'No longer a role.'],
};

// Reassurance by state (Trinity's: not started, stalled, overdue, moving, complete). Honest, never hype, never guilt.
const REASSURANCE = {
  'not started': [
    'Session 0 is only the introduction. Opening it is the whole job this week.',
    'Every actor starts with a cold read. Nobody is good at it, and nobody expects them to be.',
  ],
  starting: [
    'The first session is the hardest one to begin and the easiest to finish. Open it and do the first ten minutes.',
  ],
  stalled: [
    'A stalled course isn\'t a failed one. The degree is seven years long and farms have seasons. Pick it up with one small step, as if you never stopped.',
    'Bond goes quiet between missions too. What matters is what he does when the call comes. Make the call small: one session, this week.',
    'Restarting is a skill. The man who can pick a thing back up without drama is exactly who you\'re playing.',
  ],
  overdue: [
    'A due date passed. Move it, don\'t carry it. Trinity\'s planner can push the date to a week that has room.',
    'Late is information, not a verdict. Calving, harvest and the boys come first, and the role allows for that.',
  ],
  moving: [
    'Steady is the method. A session a week, kept, beats a month of good intentions.',
    'The work is landing even when it doesn\'t feel like it. Composure is built in exactly these unglamorous hours.',
  ],
  complete: [
    'Done, and to an outside standard. Don\'t announce it. Let it show up the next time it\'s needed.',
  ],
};
// Inspiration that isn't tied to a course: ideas, paraphrased.
const INSPIRATION = [
  'Castiglione\'s word for the Renaissance gentleman was sprezzatura: so much practice that it looks like none.',
  'Fleming said he wanted Bond plain, a man to whom things happened. The interest was in how he met them.',
  'The Stoics practised the worst case in their heads so that real trouble arrived already met.',
  'In Skyfall, Bond goes home to the hills with an old car, an old man and old tools, and wins on ground he knows.',
  'Craig built the Casino Royale body on functional work: lifting, running, swimming. Capable first, the look followed.',
  'Method actors live in the character between takes. The goal is the week you notice you haven\'t thought about it.',
  'Presence is mostly the absence of noise: no fidgeting, no filling, no fishing.',
  'The best compliment for the character is that nobody can say what he did to be impressive.',
];

const QUESTIONS = [
  { id: 'super_objective', q: 'Andrew\'s super-objective: what he wants above everything, the thing that drives every scene.', hint: 'A start, to make yours: to be the man the people who depend on me can count on in the worst hour, and to enjoy every good one.' },
  { id: 'survived', q: 'What has Andrew already survived that makes an ordinary room easy?' },
  { id: 'protects', q: 'Who does Andrew protect, and what would he give up to do it?' },
  { id: 'stopped_caring', q: 'What has Andrew stopped caring about that most men still chase?' },
  { id: 'pleasure', q: 'What is Andrew\'s one true pleasure, the thing he does slowly and on purpose?' },
  { id: 'seen', q: 'When does Andrew let people see him completely, and who are they?' },
  { id: 'trying', q: 'In what moments do you feel yourself trying too hard? What is Andrew doing instead in those moments?' },
  { id: 'model', q: 'Which man you\'ve met had the presence you want? What did he not do?' },
  { id: 'worst_hour', q: 'What is the worst hour Andrew can imagine, and what does he do in it?' },
  { id: 'never', q: 'What would Andrew never do, even if nobody would ever know?' },
  { id: 'origin', q: 'What story from your own life would Andrew tell if someone asked how he got like this?' },
];

const STUDY = [
  ['Casino Royale (2006)', 'The poker scenes: how little his face does.'],
  ['Skyfall (2012)', 'The Scotland act: Bond on rough land with old tools.'],
  ['No Time to Die (2021)', 'Bond as a father: gentle with a child, unshakable around her.'],
  ['Quantum of Solace (2008)', 'Moving through a crowd at the opera without hurrying.'],
  ['Bullitt (1968)', 'McQueen: almost no words, all presence.'],
  ['Fleming, Casino Royale (novel)', 'What Bond chooses, and his reasons.'],
];

const dayIndex = (date) => Math.floor(Date.parse(`${date}T12:00:00Z`) / 86400000);
/** Today's scene: one force, one film to study, one line of inspiration, turning over day by day. */
function todaysScene(date) {
  const n = dayIndex(date);
  return { force: FORCES[n % FORCES.length], study: STUDY[n % STUDY.length], inspiration: INSPIRATION[n % INSPIRATION.length] };
}
/** The reassurance for a course in this state (changes weekly, not on every load). */
function reassuranceFor(state, date, code = '') {
  const list = REASSURANCE[state] || REASSURANCE.moving;
  const salt = String(code).split('').reduce((s, c) => s + c.charCodeAt(0), 0);
  return list[(Math.floor(dayIndex(date) / 7) + salt) % list.length];
}

const ARTIFACTS = {
  bible: 'https://claude.ai/artifact/JrqacAi1mead3beivycCgq',
  inner_life: 'https://claude.ai/artifact/NstYh2o7fyFaMYafwKcaPV',
};

module.exports = { FORCES, SHADOW, SHADOW_RULE, ARC, ARC_INSIGHT, METHOD, LOOK, COURSE_ROLE, LEVELS, REASSURANCE, INSPIRATION, QUESTIONS, STUDY, ARTIFACTS, todaysScene, reassuranceFor };
