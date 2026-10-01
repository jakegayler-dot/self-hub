// Strength score: the ONE implementation shared by the server (Sentinel push,
// /api/fitness/sentinel-preview) and the Health tab in public/index.html,
// which loads this exact file from /js/strength.js. Keep it plain ES5 with no
// requires so it runs unchanged in both places — if you change the maths
// here, the page and Sentinel change together and can never disagree.
//
// Method: best Epley e1RM for each benchmark lift within a rolling 2-month
// (60-day) window, divided by the average bodyweight over that same window,
// scored 0-100+ against bodyweight-ratio tiers, grouped by movement pattern.
// Accessory / uncategorized lifts are excluded.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SelfHubStrength = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var WINDOW_DAYS = 60;

  // Biomechanical movement-pattern taxonomy — a simplification, not exact
  // exercise science. Covers the default 65-lift list; anything typed in
  // that isn't here falls through to keyword matching, then Uncategorized.
  var LIFT_PATTERN = {
    'Alternating DB Bench Press':'Push Horizontal','Back Rack Lunges':'Squat','Back Squat':'Squat',
    'Barbell Curl 21s':'Accessory','Barbell Drag Curls':'Accessory','Barbell Incline Bench Press':'Push Horizontal',
    'Barbell Romanian Deadlift':'Hinge','Barbell Skull Crushers':'Accessory',
    'Behind the Neck Barbell Strict Press + Barbell Strict Press':'Push Vertical','Bench Press':'Push Horizontal',
    'Bent Over Row':'Pull Horizontal','Box Squat':'Squat','Clean':'Olympic','Clean & Jerk':'Olympic',
    'Clean + Pause Split Jerk':'Olympic','Clean Pull':'Hinge','Clean Pull + Clean + Jerk':'Olympic',
    'DB Box Step-Ups':'Squat','DB Preacher Curl':'Accessory','Deadlift':'Hinge',
    'Double DB Standing Bent Over Row':'Pull Horizontal','Elevated Toe Double DB Romanian Deadlift':'Hinge',
    'Front Squat':'Squat','Front Squat + Back Squat':'Squat','Hang Squat Clean':'Olympic','Hex Press':'Push Horizontal',
    'In The Hole Front Squat':'Squat','Incline Bench DB Chest Fly':'Accessory','Lat Pulldowns':'Pull Vertical',
    'Muscle Clean':'Olympic','Muscle Clean + High Hang Power Clean':'Olympic','Muscle Clean + Tall Clean':'Olympic',
    'Overhead Squat':'Squat','Pause Front Squat + Front Squat':'Squat','Pause High Hang Power Snatch + Overhead Squat':'Olympic',
    'Pause Snatch Balance':'Olympic','Power Clean':'Olympic','Power Snatch':'Olympic','Push Press':'Push Vertical',
    'Romanian Deadlift':'Hinge','Seated Press':'Push Vertical','Seated Strict Shoulder Press':'Push Vertical',
    'Shoulder Press':'Push Vertical','Snatch':'Olympic','Snatch Balance':'Olympic','Snatch Balance + Overhead Squats':'Olympic',
    'Snatch Deadlift to Mid Thigh + Snatch High Pull + Snatch':'Olympic','Snatch Pull':'Hinge',
    'Snatch Pull + Power Snatch + Snatch High Pull + Snatch':'Olympic','Snatch Pull + Snatch':'Olympic',
    'Snatch Pull + Snatch + Snatch High Pull + Snatch':'Olympic','Snatch Pull + Snatch High Pull + Power Snatch':'Olympic',
    'Snatch Push Press + Overhead Squat':'Olympic','Split Jerk':'Push Vertical','Squat Pause Clean':'Olympic',
    'Standing KB Crush Grip Bicep Curl':'Accessory','Standing KB Crush Grip French Press':'Accessory',
    'Strict Press':'Push Vertical','Strict Pull-Ups':'Pull Vertical','Sumo Deadlift':'Hinge',
    'Sumo Deadlift + Deadlift':'Hinge','Tempo Heel Elevated Back Squat':'Squat','Thruster':'Squat',
    'Weighted Pull-Up':'Pull Vertical','Wide Grip Bench Press + DB Single Arm Bench Press':'Push Horizontal'
  };
  // Bodyweight/calisthenics movements — mapped onto the same pattern
  // taxonomy as loaded lifts, since the underlying joint action is the
  // same even without external load. Handstand work is kept as its own
  // "Balance" pattern since it's stability/skill-dominant rather than a
  // conventional strength movement pattern.
  var GYMNASTICS_PATTERN = {
    'Handstand Walk':'Balance', 'HSPU':'Push Vertical', 'Push-Ups':'Push Horizontal',
    'Sit-Ups':'Core', 'Toes-to-Bar':'Core', 'Pistol Squats':'Squat',
    'Strict Pull-Ups':'Pull Vertical', 'Chest-to-Bar':'Pull Vertical',
    'Butterfly Pull-Ups':'Pull Vertical', 'Bar Muscle-Ups':'Pull Vertical'
  };
  function liftPattern(name){
    if(LIFT_PATTERN[name]) return LIFT_PATTERN[name];
    if(GYMNASTICS_PATTERN[name]) return GYMNASTICS_PATTERN[name];
    var s=name.toLowerCase();
    if(/handstand/.test(s)) return 'Balance';
    if(/hspu/.test(s)) return 'Push Vertical';
    if(/push-?up/.test(s)) return 'Push Horizontal';
    if(/sit-?up|toes.?to.?bar|l-?sit|hollow/.test(s)) return 'Core';
    if(/pistol/.test(s)) return 'Squat';
    if(/muscle-?up|chest.?to.?bar|butterfly/.test(s)) return 'Pull Vertical';
    if(/squat|lunge|step-up/.test(s)) return 'Squat';
    if(/deadlift/.test(s)) return 'Hinge';
    if(/clean|snatch|jerk/.test(s)) return 'Olympic';
    if(/bench|fly|dip/.test(s)) return 'Push Horizontal';
    if(/press/.test(s)) return 'Push Vertical';
    if(/pull-up|pullup|pulldown/.test(s)) return 'Pull Vertical';
    if(/row/.test(s)) return 'Pull Horizontal';
    if(/curl|tricep|skull crusher/.test(s)) return 'Accessory';
    return 'Uncategorized';
  }

  // Bodyweight-ratio strength standards (male, 5 tiers), synthesized from
  // several independently published strength-standard tables as a
  // good-faith approximation — not any single site's exact proprietary
  // dataset. Cross-check strengthlevel.com directly if you want the
  // authoritative numbers. [beginner, novice, intermediate, advanced,
  // elite] as multiples of bodyweight.
  var STRENGTH_STANDARDS = {
    'Back Squat':[0.75,1.1,1.55,2.1,2.6], 'Front Squat':[0.60,0.9,1.25,1.7,2.1],
    'Box Squat':[0.70,1.0,1.4,1.9,2.4], 'Overhead Squat':[0.45,0.65,0.9,1.2,1.5],
    'Bench Press':[0.5,0.8,1.15,1.55,1.95],
    'Deadlift':[1.0,1.4,1.9,2.45,3.0], 'Sumo Deadlift':[1.0,1.4,1.9,2.45,3.0], 'Romanian Deadlift':[0.75,1.05,1.4,1.8,2.2],
    'Strict Press':[0.35,0.5,0.75,1.0,1.3], 'Shoulder Press':[0.35,0.5,0.75,1.0,1.3],
    'Seated Press':[0.3,0.45,0.65,0.9,1.15], 'Push Press':[0.45,0.65,0.98,1.3,1.7],
    'Bent Over Row':[0.5,0.75,1.0,1.4,1.75],
    'Strict Pull-Ups':[0,0.1,0.25,0.45,0.7], 'Weighted Pull-Up':[0,0.1,0.25,0.45,0.7],
    'Clean & Jerk':[0.5,0.75,1.25,1.6,2.0], 'Clean':[0.53,0.79,1.31,1.68,2.1], 'Power Clean':[0.45,0.67,1.11,1.43,1.79],
    'Snatch':[0.39,0.59,0.98,1.25,1.56], 'Power Snatch':[0.33,0.50,0.83,1.06,1.33], 'Split Jerk':[0.53,0.79,1.31,1.68,2.1]
  };
  var PATTERN_STANDARD_FALLBACK = {
    'Squat':'Back Squat','Hinge':'Deadlift','Push Vertical':'Strict Press','Push Horizontal':'Bench Press',
    'Pull Vertical':'Weighted Pull-Up','Pull Horizontal':'Bent Over Row','Olympic':'Clean & Jerk'
  };
  function standardsFor(liftName){
    if(STRENGTH_STANDARDS[liftName]) return STRENGTH_STANDARDS[liftName];
    var fb = PATTERN_STANDARD_FALLBACK[liftPattern(liftName)];
    return fb ? STRENGTH_STANDARDS[fb] : null;
  }
  function levelScore(ratio, tiers){
    var vals=[0,tiers[0],tiers[1],tiers[2],tiers[3],tiers[4]], pts=[0,20,40,60,80,100];
    if(ratio>=vals[5]){
      var slope=(pts[5]-pts[4])/(vals[5]-vals[4] || 1);
      return Math.round(100 + (ratio-vals[5])*slope);
    }
    for(var i=1;i<=5;i++){
      if(ratio<=vals[i]){
        var frac = (vals[i]===vals[i-1]) ? 1 : (ratio-vals[i-1])/(vals[i]-vals[i-1]);
        return Math.round(pts[i-1] + frac*(pts[i]-pts[i-1]));
      }
    }
    return 100;
  }
  function levelLabel(score){
    if(score<20) return 'Below beginner';
    if(score<40) return 'Beginner';
    if(score<60) return 'Novice';
    if(score<80) return 'Intermediate';
    if(score<100) return 'Advanced';
    return 'Elite';
  }
  // lifts / bodyweight are rows shaped like GET /api/fitness/lifts and
  // /bodyweight: entry_date may be a Date (pg) or its JSON ISO string.
  function windowedBestE1RM(lifts, liftName, windowStart, windowEnd){
    var best=null;
    lifts.forEach(function(l){
      if(l.lift!==liftName) return;
      var d=new Date(l.entry_date);
      if(d<windowStart || d>windowEnd) return;
      var e=l.load_lb*(1+l.reps/30);
      if(best===null||e>best) best=e;
    });
    return best;
  }
  function windowedAvgBodyweight(bodyweight, windowStart, windowEnd){
    var vals=[];
    bodyweight.forEach(function(b){
      var d=new Date(b.entry_date);
      if(d>=windowStart && d<=windowEnd) vals.push(Number(b.weight_lb));
    });
    if(!vals.length) return null;
    return vals.reduce(function(a,b){return a+b;},0)/vals.length;
  }
  function windowStartFor(end){
    var s = new Date(end); s.setUTCDate(s.getUTCDate()-WINDOW_DAYS); return s;
  }

  // The Health tab's "Strength profile" section, as data.
  //   data: { lifts, bodyweight (ASC by date), benchmarkLifts }
  // Returns:
  //   avgBW            — 2-month avg bodyweight, or the last logged weight if
  //                      none in the window (bwFromWindow=false), or null
  //   rows             — breakdown table rows, sorted as the table shows them
  //   patterns         — level cards [{pattern, score, level}], weakest first
  function computeStrengthProfile(data, now){
    now = now || new Date();
    var windowStart = windowStartFor(now);
    var avgBW = windowedAvgBodyweight(data.bodyweight, windowStart, now);
    var bwFromWindow = avgBW !== null;
    if(avgBW===null && data.bodyweight.length){ avgBW = Number(data.bodyweight[data.bodyweight.length-1].weight_lb); }

    var benchSet = new Set(data.benchmarkLifts);
    var rows = [];
    var byPattern = {};
    benchSet.forEach(function(lift){
      var p = liftPattern(lift);
      if(p==='Accessory' || p==='Uncategorized') return;
      var tiers = standardsFor(lift);
      if(!tiers) return;
      var e1rm = windowedBestE1RM(data.lifts, lift, windowStart, now);
      if(e1rm===null) return;
      var ratio = avgBW ? e1rm/avgBW : null;
      var score = (ratio!=null) ? levelScore(ratio, tiers) : null;
      if(!byPattern[p]) byPattern[p]=[];
      if(score!=null) byPattern[p].push(score);
      rows.push({pattern:p, lift:lift, e1rm:Math.round(e1rm*10)/10,
        ratio:ratio, score:score, level: score!=null?levelLabel(score):'—'});
    });
    rows.sort(function(a,b){ return a.pattern.localeCompare(b.pattern) || (b.score||0)-(a.score||0); });

    function mean(vals){ return vals.reduce(function(s,v){return s+v;},0)/vals.length; }
    var patternNames = Object.keys(byPattern).sort(function(a,b){
      return mean(byPattern[a]) - mean(byPattern[b]);
    });
    var patterns = patternNames.map(function(p){
      var avg = Math.round(mean(byPattern[p]));
      return {pattern:p, score:avg, level:levelLabel(avg)};
    });
    return { windowStart: windowStart, windowEnd: now, avgBW: avgBW, bwFromWindow: bwFromWindow, rows: rows, patterns: patterns };
  }

  // Weekly points for the "Pattern trend" chart: [{x: Date, y: score}], or null
  // when no benchmark lift in that pattern has ever been logged.
  function computeStrengthTrend(data, pattern, now){
    now = now || new Date();
    var benchSet = new Set(data.benchmarkLifts);
    var liftsInPattern = Array.from(benchSet).filter(function(l){ return liftPattern(l)===pattern && standardsFor(l); });
    var relevantDates = data.lifts.filter(function(l){ return liftsInPattern.indexOf(l.lift)!==-1; }).map(function(l){ return new Date(l.entry_date); });
    if(!relevantDates.length) return null; // no lifts at all for this pattern (page shows an empty chart)
    var earliest = new Date(Math.min.apply(null, relevantDates));
    var points=[];
    var cursor = new Date(earliest);
    while(cursor<=now){
      var wStart = windowStartFor(cursor);
      var avgBW = windowedAvgBodyweight(data.bodyweight, wStart, cursor);
      if(avgBW!=null){
        var scores=[];
        liftsInPattern.forEach(function(lift){
          var e1rm = windowedBestE1RM(data.lifts, lift, wStart, cursor);
          if(e1rm!=null){ scores.push(levelScore(e1rm/avgBW, standardsFor(lift))); }
        });
        if(scores.length){ points.push({x:new Date(cursor), y:Math.round(scores.reduce(function(a,b){return a+b;},0)/scores.length)}); }
      }
      cursor.setUTCDate(cursor.getUTCDate()+7);
    }
    return points;
  }

  return {
    WINDOW_DAYS: WINDOW_DAYS,
    LIFT_PATTERN: LIFT_PATTERN,
    GYMNASTICS_PATTERN: GYMNASTICS_PATTERN,
    STRENGTH_STANDARDS: STRENGTH_STANDARDS,
    liftPattern: liftPattern,
    standardsFor: standardsFor,
    levelScore: levelScore,
    levelLabel: levelLabel,
    windowedBestE1RM: windowedBestE1RM,
    windowedAvgBodyweight: windowedAvgBodyweight,
    computeStrengthProfile: computeStrengthProfile,
    computeStrengthTrend: computeStrengthTrend
  };
});
