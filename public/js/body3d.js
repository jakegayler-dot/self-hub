// The physique figure (2026-10-31): a 3D anatomical model, about 70 muscles in 17 groups, sized from his height and
// tape measurements and coloured by this week's sets. Drag to turn it; tap a muscle for its group.
// Three.js r128 (the UMD build on cdnjs). Everything is authored in a 70-inch "base" frame (y up from the floor,
// z toward the viewer) and mapped onto his proportions by Y() and the width factors.
(function () {
  'use strict';

  var GROUPS = {
    chest:      { label: 'Chest', latin: 'pectoralis major', measure: 'bust', grow: ['Bench press', 'Incline DB press', 'Dips', 'Push-ups', 'Cable flyes'] },
    shoulders:  { label: 'Shoulders', latin: 'deltoids, front, side and rear', measure: 'shoulder', grow: ['Strict press', 'Push press', 'Lateral raises', 'Rear-delt flyes', 'Handstand push-ups'] },
    traps:      { label: 'Traps', latin: 'trapezius', measure: 'neck', grow: ['Shrugs', 'Clean pulls', "Farmer's carries", 'Snatch-grip deadlifts'] },
    lats:       { label: 'Lats', latin: 'latissimus dorsi', measure: 'bust', grow: ['Pull-ups', 'Chin-ups', 'Lat pulldowns', 'Straight-arm pulldowns'] },
    midback:    { label: 'Mid back', latin: 'rhomboids, teres, infraspinatus', measure: 'bust', grow: ['Barbell rows', 'Seal rows', 'Ring rows', 'Face pulls'] },
    lowerback:  { label: 'Lower back', latin: 'erector spinae', measure: null, grow: ['Deadlifts', 'Good mornings', 'Back extensions'] },
    biceps:     { label: 'Biceps', latin: 'biceps brachii', measure: null, grow: ['Chin-ups', 'Barbell curls', 'Hammer curls', 'Rope climbs'] },
    triceps:    { label: 'Triceps', latin: 'triceps brachii', measure: null, grow: ['Dips', 'Close-grip bench', 'Overhead extensions', 'Pushdowns'] },
    forearms:   { label: 'Forearms', latin: 'flexors, extensors, brachioradialis', measure: null, grow: ["Farmer's carries", 'Deadlifts', 'Dead hangs', 'Wrist curls'] },
    abs:        { label: 'Abs', latin: 'rectus abdominis', measure: 'waist', grow: ['Toes-to-bar', 'Hanging leg raises', 'Ab wheel', 'Sit-ups'] },
    obliques:   { label: 'Obliques and serratus', latin: 'external obliques, serratus anterior', measure: 'waist', grow: ['Pallof press', 'Side planks', 'Suitcase carries'] },
    glutes:     { label: 'Glutes', latin: 'gluteus maximus and medius', measure: 'seat_hips', grow: ['Hip thrusts', 'Back squats', 'Romanian deadlifts', 'Walking lunges'] },
    quads:      { label: 'Quads', latin: 'quadriceps and sartorius', measure: null, grow: ['Back squats', 'Front squats', 'Bulgarian split squats', 'Leg extensions'] },
    adductors:  { label: 'Adductors', latin: 'inner thigh', measure: null, grow: ['Wide-stance squats', 'Sumo deadlifts', 'Copenhagen planks'] },
    hamstrings: { label: 'Hamstrings', latin: 'biceps femoris, semitendinosus', measure: null, grow: ['Romanian deadlifts', 'Nordic curls', 'Leg curls', 'Good mornings'] },
    calves:     { label: 'Calves', latin: 'gastrocnemius, soleus, tibialis', measure: null, grow: ['Standing calf raises', 'Seated calf raises', 'Jump rope'] },
    neck:       { label: 'Neck', latin: 'sternocleidomastoid', measure: 'neck', grow: ['Neck harness curls and extensions', 'Shrugs'] }
  };

  var hex = function (h) { return new THREE.Color(h).convertSRGBToLinear(); };
  var RAMP = ['#5b2d23', '#9a5634', '#dcae5a']; // none, 5 sets, 10+ sets (sRGB)
  function rampColor(t) {
    var a = new THREE.Color(t < 0.5 ? RAMP[0] : RAMP[1]), b = new THREE.Color(t < 0.5 ? RAMP[1] : RAMP[2]);
    return a.lerp(b, t < 0.5 ? t * 2 : (t - 0.5) * 2).convertSRGBToLinear();
  }

  // Muscle fibre striations: fine stripes along each muscle's length, used as a bump map.
  function fibreTexture() {
    var c = document.createElement('canvas'); c.width = 512; c.height = 8;
    var g = c.getContext('2d');
    for (var i = 0; i < 512; i++) { var v = Math.round(118 + (Math.random() - 0.5) * 120 + 30 * Math.sin(i * 0.9)); g.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')'; g.fillRect(i, 0, 1, 8); }
    var t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 1);
    return t;
  }

  var V = function (x, y, z) { return new THREE.Vector3(x, y, z); };
  function basisQuat(dir, out) {
    var y = dir.clone().normalize();
    var z = out.clone().sub(y.clone().multiplyScalar(out.dot(y)));
    if (z.lengthSq() < 1e-6) z = Math.abs(y.z) < 0.9 ? V(0, 0, 1) : V(1, 0, 0);
    z.normalize();
    var x = new THREE.Vector3().crossVectors(y, z);
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  }
  // A fusiform muscle: pointed tendons at both ends, the belly at `peak` (0..1 along it).
  function spindleGeo(len, r, o) {
    var pts = [], n = 22, p = o.p || 0.45, k = Math.log(0.5) / Math.log(o.peak || 0.5);
    for (var i = 0; i <= n; i++) {
      var t = i / n, rr = (i === 0 || i === n) ? 0 : r * Math.pow(Math.sin(Math.PI * Math.pow(t, k)), p);
      pts.push(new THREE.Vector2(rr, t * len));
    }
    var g = new THREE.LatheGeometry(pts, 28);
    g.scale(o.wide || 1, 1, o.flat || 1);
    return g;
  }
  function smoothKF(kf, y, i) { // Catmull-Rom through keyframes [y, ...values] at column i
    var n = kf.length;
    if (y <= kf[0][0]) return kf[0][i];
    if (y >= kf[n - 1][0]) return kf[n - 1][i];
    var j = 0; while (kf[j + 1][0] < y) j++;
    var p0 = kf[Math.max(0, j - 1)], p1 = kf[j], p2 = kf[j + 1], p3 = kf[Math.min(n - 1, j + 2)];
    var t = (y - p1[0]) / (p2[0] - p1[0]);
    var m1 = (p2[i] - p0[i]) / 2, m2 = (p3[i] - p1[i]) / 2;
    var t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p1[i] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[i] + (t3 - t2) * m2;
  }

  function buildFigure(body, mats, fibre) {
    var fig = new THREE.Group(), meshes = [];
    var H = body.height || 70, k = H / 70;
    var shS = (body.shoulder || 18) / 18, chS = (body.bust || 40) / 40, waS = (body.waist || 34) / 34, hiS = (body.hips || 38) / 38, neS = (body.neck || 15) / 15;
    var sleeve = body.sleeve || 24, crotch = (body.inseam || 31) + 1, shY = H * 57.5 / 70;
    function Y(b) {
      if (b <= 32) return b * crotch / 32;
      if (b <= 57.5) return crotch + (b - 32) * (shY - crotch) / 25.5;
      return shY + (b - 57.5) * (H - shY) / 12.5;
    }
    // The torso's half-width, half-depth and centre (z) by height, scaled by his measurements.
    var KF = [
      [29.6, 2.2 * hiS, 1.9, -0.3], [31.0, 4.6 * hiS, 3.2, -0.3], [34.6, 6.4 * hiS, 4.0, -0.5], [38.4, 6.0 * Math.sqrt(hiS * waS), 3.85, -0.2],
      [41.6, 5.45 * waS, 3.75 * Math.sqrt(waS), 0], [45.0, 5.6 * Math.sqrt(waS * chS), 3.95, 0.1], [49.0, 6.15 * chS, 4.35 * Math.sqrt(chS), 0],
      [52.5, 6.35 * chS, 4.35 * Math.sqrt(chS), -0.1], [55.5, 5.9 * Math.sqrt(chS * shS), 3.9, -0.3], [57.5, 4.5 * shS, 3.1, -0.5],
      [59.0, 2.55 * neS, 2.35 * neS, -0.45], [62.0, 2.2 * neS, 2.2 * neS, -0.2]
    ];
    function prof(b) { return { w: smoothKF(KF, b, 1), d: smoothKF(KF, b, 2), zc: smoothKF(KF, b, 3) }; }
    function surf(b, ang, s) {
      var p = prof(b), a = ang * Math.PI / 180;
      return { p: V(s * Math.sin(a) * p.w, Y(b), p.zc + Math.cos(a) * p.d), n: V(s * Math.sin(a) / p.w, 0, Math.cos(a) / p.d).normalize() };
    }
    function add(mesh, group) { mesh.userData.group = group || null; fig.add(mesh); if (group) meshes.push(mesh); return mesh; }
    function spindle(a, b, r, group, o) {
      o = o || {};
      var dir = b.clone().sub(a), m = new THREE.Mesh(spindleGeo(dir.length(), r * k * (group ? 1.2 : 1), o), group ? mats.group[group] : (o.mat || mats.core));
      m.position.copy(a); m.quaternion.copy(basisQuat(dir, o.out || V(0, 0, 1)));
      return add(m, group);
    }
    function blob(c, axis, out, rLen, rWide, rThick, group, mat) {
      var g = new THREE.SphereGeometry(1, 36, 24), gr = group ? 1.12 : 1; g.scale(rWide * k * gr, rLen * k * (group ? 1.06 : 1), rThick * k);
      var m = new THREE.Mesh(g, group ? mats.group[group] : (mat || mats.core));
      m.position.copy(c); m.quaternion.copy(basisQuat(axis, out));
      return add(m, group);
    }
    function joint(p, r, mat) { var m = new THREE.Mesh(new THREE.SphereGeometry(r * k, 24, 16), mat || mats.core); m.position.copy(p); return add(m); }
    function limbCore(a, b, r0, r1) {
      var d = b.clone().sub(a), g = new THREE.CylinderGeometry(r1 * k, r0 * k, d.length(), 24, 1, true);
      g.translate(0, d.length() / 2, 0);
      var m = new THREE.Mesh(g, mats.core); m.position.copy(a); m.quaternion.copy(basisQuat(d, V(0, 0, 1)));
      return add(m);
    }
    // Front, lateral and medial unit vectors around a limb segment.
    function frame(a, b, s) {
      var d = b.clone().sub(a).normalize();
      var f = V(0, 0, 1).sub(d.clone().multiplyScalar(d.z)).normalize();
      var lat = new THREE.Vector3().crossVectors(f, d).normalize(); if (lat.x * s < 0) lat.negate();
      return { d: d, f: f, lat: lat, med: lat.clone().negate(), back: f.clone().negate() };
    }
    var P = function (base) { var v = base.clone(); for (var i = 1; i < arguments.length; i += 2) v.add(arguments[i].clone().multiplyScalar(arguments[i + 1] * k)); return v; };

    // ---- the dark under-body: torso, neck, limbs ----
    (function () {
      var rings = 64, seg = 48, pos = [], idx = [], b0 = 29.6, b1 = 62.0;
      for (var i = 0; i <= rings; i++) {
        var b = b0 + (b1 - b0) * i / rings, p = prof(b), y = Y(b);
        for (var j = 0; j <= seg; j++) { var a = j / seg * Math.PI * 2; pos.push(Math.sin(a) * p.w, y, p.zc + Math.cos(a) * p.d); }
      }
      for (i = 0; i < rings; i++) for (var j2 = 0; j2 < seg; j2++) {
        var a0 = i * (seg + 1) + j2, b2 = a0 + 1, c0 = a0 + seg + 1, d0 = c0 + 1;
        idx.push(a0, b2, c0, b2, d0, c0);
      }
      var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      add(new THREE.Mesh(g, mats.core));
    })();

    // ---- head, jaw, collarbones, sternum ----
    blob(V(0, Y(65.8), 0.25), V(0, 1, 0.08), V(0, 0, 1), 4.25, 3.05, 3.6, null, mats.bone);
    blob(V(0, Y(63.1), 0.95), V(0, 1, 0.35), V(0, 0, 1), 1.9, 2.25, 2.6, null, mats.bone);
    var shoulderX = 7.3 * shS;
    [-1, 1].forEach(function (s) {
      spindle(V(s * 0.8, Y(58.4), 2.05), V(s * (shoulderX - 0.6), Y(57.8), 0.4), 0.42, null, { mat: mats.bone, p: 0.25, out: V(0, 1, 0) });
    });
    blob(V(0, Y(53.5), prof(53.5).d + prof(53.5).zc - 0.25), V(0, 1, 0), V(0, 0, 1), 3.4, 0.55, 0.35, null, mats.bone);

    [-1, 1].forEach(function (s) {
      var c, sf;
      // ---- neck ----
      spindle(V(s * 1.85, Y(63.2), -0.4), V(s * 0.55, Y(58.5), 1.9), 0.62, 'neck', { out: V(s * 0.6, 0, 1), p: 0.45 });
      // ---- chest ----
      sf = surf(50.8, 34, s); blob(P(sf.p, sf.n, 0.5), V(s, 0.2, -0.3), sf.n, 4.1, 3.0, 1.05, 'chest');
      sf = surf(53.4, 32, s); blob(P(sf.p, sf.n, 0.35), V(s, -0.08, -0.25), sf.n, 3.3, 1.5, 0.75, 'chest');
      // ---- abs: four rows, the lowest longest ----
      [[47.3, 1.2], [44.9, 1.2], [42.5, 1.2], [39.4, 1.95]].forEach(function (r) { sf = surf(r[0], 12, s); blob(P(sf.p, sf.n, 0.2), V(0, 1, 0), sf.n, r[1], 1.12, 0.4, 'abs'); });
      // ---- obliques and serratus ----
      sf = surf(40.6, 66, s); blob(P(sf.p, sf.n, 0.3), V(-s * 0.3, 1, 0.2), sf.n, 4.4, 2.5, 0.62, 'obliques');
      for (var i = 0; i < 3; i++) {
        sf = surf(47.8 - 1.45 * i, 80, s);
        var tan = new THREE.Vector3().crossVectors(sf.n, V(0, 1, 0)).multiplyScalar(-s).add(V(0, -0.45, 0));
        blob(P(sf.p, sf.n, 0.25), tan, sf.n, 1.3, 0.55, 0.42, 'obliques');
      }
      // ---- back ----
      sf = surf(47.4, 122, s); blob(P(sf.p, sf.n, 0.5), V(s * 0.25, 1, 0.15), sf.n, 6.4, 3.4, 1.0, 'lats');
      sf = surf(52.4, 160, s); blob(P(sf.p, sf.n, 0.3), V(s * 0.5, 1, 0), sf.n, 4.6, 2.3, 0.55, 'traps');
      sf = surf(53.0, 140, s); blob(P(sf.p, sf.n, 0.42), V(s, -0.3, 0), sf.n, 2.2, 1.7, 0.6, 'midback');
      sf = surf(52.4, 168, s); blob(P(sf.p, sf.n, 0.25), V(s * 0.4, 1, 0), sf.n, 2.0, 1.0, 0.5, 'midback');
      sf = surf(50.6, 132, s); spindle(P(sf.p, sf.n, 0.5), V(s * (shoulderX - 1.6), Y(53.6), -1.9), 0.95, 'midback', { out: sf.n, p: 0.5 });
      var e0 = surf(35.4, 171, s), e1 = surf(50.0, 171, s);
      spindle(P(e0.p, e0.n, 0.45), P(e1.p, e1.n, 0.35), 1.05, 'lowerback', { out: e0.n, flat: 0.6, p: 0.45 });
      spindle(V(s * 1.3, Y(60.0), -1.0), V(s * (shoulderX - 0.6), Y(57.7), -0.9), 1.15, 'traps', { out: V(s * 0.25, 0.85, -0.45), flat: 0.75, p: 0.5 });
      // ---- glutes ----
      sf = surf(34.8, 148, s); blob(P(sf.p, sf.n, 0.55), V(s * 0.6, -0.8, -0.1), sf.n, 4.2, 3.4, 1.75, 'glutes');
      sf = surf(37.9, 104, s); blob(P(sf.p, sf.n, 0.5), V(-s * 0.2, 1, 0), sf.n, 2.5, 1.9, 0.9, 'glutes');

      // ---- arm: shoulder, elbow, wrist ----
      var Sj = V(s * (shoulderX - 1.0), Y(56.3), -0.3);
      var ua = V(s * Math.sin(0.16), -Math.cos(0.16), 0.02).normalize(), up = sleeve * 0.52 * Math.pow(k, 0.2);
      var E = Sj.clone().add(ua.clone().multiplyScalar(up));
      var fa = V(s * Math.sin(0.2), -Math.cos(0.2), Math.sin(0.14)).normalize(), fl = sleeve * 0.44 * Math.pow(k, 0.2);
      var W = E.clone().add(fa.clone().multiplyScalar(fl));
      var u = frame(Sj, E, s), f = frame(E, W, s);
      joint(Sj, 1.7); limbCore(Sj, E, 1.5, 1.2); joint(E, 1.2); limbCore(E, W, 1.25, 0.8); joint(W, 0.8);
      var D = P(Sj, ua, 5.4, u.lat, 0.55);
      spindle(V(s * (shoulderX - 1.75), Y(57.2), 1.3), P(D, u.f, 0.6), 1.38, 'shoulders', { out: V(s * 0.35, 0.25, 1), p: 0.5 });
      spindle(V(s * (shoulderX + 0.15), Y(57.75), -0.25), P(D, u.lat, 0.2), 1.62, 'shoulders', { out: V(s, 0.35, 0), p: 0.5 });
      spindle(V(s * (shoulderX - 1.5), Y(57.0), -1.85), P(D, u.back, 0.6), 1.32, 'shoulders', { out: V(s * 0.35, 0.25, -1), p: 0.5 });
      spindle(P(Sj, ua, 2.2, u.f, 1.0), P(E, ua, -0.9, u.f, 0.65), 1.38, 'biceps', { out: u.f, flat: 0.9, p: 0.55, peak: 0.58 });
      spindle(P(Sj, ua, 1.4, u.back, 1.0, u.med, 0.3), P(E, u.back, 0.7, ua, -0.4), 1.36, 'triceps', { out: u.back, p: 0.55, peak: 0.42 });
      spindle(P(Sj, ua, 2.6, u.back, 0.55, u.lat, 0.85), P(Sj, ua, 9.2, u.back, 0.9, u.lat, 0.35), 1.02, 'triceps', { out: u.lat, p: 0.5 });
      spindle(P(E, ua, -2.6, u.lat, 0.95, u.f, 0.3), P(E, fa, fl * 0.72 / k, f.lat, 0.5, f.f, 0.2), 1.0, 'forearms', { out: f.lat, p: 0.5, peak: 0.36 });
      spindle(P(E, f.med, 0.8, f.f, 0.45), P(W, f.f, 0.3, fa, -0.5), 0.98, 'forearms', { out: f.f, p: 0.55, peak: 0.3 });
      spindle(P(E, f.lat, 0.55, f.back, 0.55), P(W, f.back, 0.3, fa, -0.5), 0.86, 'forearms', { out: f.back, p: 0.55, peak: 0.33 });
      blob(P(W, fa, 2.7), fa, f.f, 2.7, 1.55, 0.72, null, mats.bone);
      spindle(P(W, fa, 0.6, f.lat, 1.0), P(W, fa, 3.3, f.lat, 1.9, f.f, 0.6), 0.45, null, { mat: mats.bone, out: f.f, p: 0.3 });

      // ---- leg: hip, knee, ankle ----
      var Hj = V(s * 3.6 * hiS, Y(34.6), -0.1), K = V(s * 3.75 * Math.sqrt(hiS), Y(19.5), 0.45), A = V(s * 3.9, Y(3.4), -0.5);
      var t = frame(Hj, K, s), sh = frame(K, A, s), tl = Hj.distanceTo(K) / k, sl = K.distanceTo(A) / k;
      joint(Hj, 2.9); limbCore(Hj, K, 2.95, 2.0); joint(K, 2.0); limbCore(K, A, 2.0, 1.15); joint(A, 1.15);
      spindle(P(Hj, t.f, 2.0, t.d, -2.0), P(K, t.f, 1.9, t.d, -2.3), 1.75, 'quads', { out: t.f, p: 0.55 });
      spindle(P(Hj, t.d, -0.6, t.lat, 2.6, t.f, 0.5), P(K, t.d, -2.5, t.lat, 1.65, t.f, 1.1), 2.0, 'quads', { out: t.lat, p: 0.45, peak: 0.45, wide: 1.15 });
      spindle(P(Hj, t.d, 7.0, t.med, 1.9, t.f, 0.95), P(K, t.d, -1.2, t.med, 1.35, t.f, 1.2), 1.8, 'quads', { out: t.med.clone().add(t.f), p: 0.5, peak: 0.72 });
      spindle(V(s * 5.3 * hiS, Y(37.6), 2.5), P(K, t.med, 1.9, t.back, 0.3), 0.45, 'quads', { out: t.f, p: 0.3 });
      blob(P(Hj, t.d, 3.6, t.med, 2.1, t.back, 0.2), t.d.clone().add(t.med.clone().multiplyScalar(0.35)), t.med, 4.8, 2.3, 1.4, 'adductors');
      spindle(P(Hj, t.back, 2.3, t.lat, 0.6, t.d, 0.6), P(K, t.back, 1.5, t.lat, 1.25, t.d, -1.0), 1.55, 'hamstrings', { out: t.back.clone().add(t.lat.clone().multiplyScalar(0.4)), p: 0.55 });
      spindle(P(Hj, t.back, 2.3, t.med, 0.7, t.d, 0.6), P(K, t.back, 1.3, t.med, 1.3, t.d, -1.0), 1.48, 'hamstrings', { out: t.back.clone().add(t.med.clone().multiplyScalar(0.4)), p: 0.55 });
      spindle(V(s * 5.7 * hiS, Y(38.0), 1.0), P(Hj, t.d, 6.0, t.lat, 2.7, t.f, 0.2), 1.05, 'glutes', { out: t.lat.clone().add(t.f), p: 0.5, peak: 0.35 });
      sf = surf(36.4, 34, s); blob(P(sf.p, sf.n, 0.3), V(s * 0.45, -1, 0.1), sf.n, 2.4, 1.5, 0.7, 'quads');
      blob(P(K, t.f, 1.9, t.d, -0.1), t.d, t.f, 1.25, 1.0, 0.6, null, mats.bone);
      spindle(P(K, sh.back, 1.25, sh.med, 0.8, sh.d, -1.0), P(A, sh.d, -7.2, sh.back, 1.0, sh.med, 0.3), 1.48, 'calves', { out: sh.back.clone().add(sh.med.clone().multiplyScalar(0.45)), p: 0.5, peak: 0.36 });
      spindle(P(K, sh.back, 1.25, sh.lat, 0.8, sh.d, -1.0), P(A, sh.d, -8.2, sh.back, 1.0, sh.lat, 0.4), 1.28, 'calves', { out: sh.back.clone().add(sh.lat.clone().multiplyScalar(0.45)), p: 0.5, peak: 0.36 });
      spindle(P(K, sh.d, 4.0, sh.back, 0.8), P(A, sh.d, -1.6, sh.back, 0.9), 1.3, 'calves', { out: sh.back, wide: 1.25, flat: 0.75, p: 0.5, peak: 0.55 });
      spindle(P(K, sh.d, 1.6, sh.f, 1.15, sh.lat, 0.6), P(A, sh.d, -2.4, sh.f, 0.85, sh.lat, 0.1), 0.95, 'calves', { out: sh.f, wide: 1.25, p: 0.45, peak: 0.35 });
      spindle(P(K, sh.d, 1.8, sh.lat, 1.45, sh.back, 0.1), P(A, sh.d, -2.0, sh.lat, 0.9), 0.75, 'calves', { out: sh.lat, p: 0.5, peak: 0.4 });
      blob(P(A, V(0, -1, 0), 1.7, V(0, 0, 1), 2.2), V(0, 0.12, 1), V(0, 1, 0), 4.5, 1.5, 1.05, null, mats.bone);
    });

    // ---- the plinth he stands on ----
    var pl = new THREE.Mesh(new THREE.CylinderGeometry(11, 11.8, 1.4, 72), mats.stone); pl.position.y = -0.7; fig.add(pl);
    var ring = new THREE.Mesh(new THREE.TorusGeometry(11.05, 0.13, 8, 120), mats.brass); ring.rotation.x = Math.PI / 2; ring.position.y = 0.02; fig.add(ring);
    return { group: fig, meshes: meshes, height: H };
  }

  function mount(el, opts) {
    opts = opts || {};
    if (!window.THREE) { el.innerHTML = '<p class="trk-note b3d-msg">The 3D figure could not load (no connection to cdnjs).</p>'; return null; }
    var renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); }
    catch (e) { el.innerHTML = '<p class="trk-note b3d-msg">This browser has 3D graphics (WebGL) turned off, so the figure can\'t show.</p>'; return null; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    el.insertBefore(renderer.domElement, el.firstChild);
    var cv = renderer.domElement; cv.className = 'b3d-canvas';

    var scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(24, 1, 10, 1000), target = new THREE.Object3D();
    scene.add(cam); scene.add(target);
    scene.add(new THREE.HemisphereLight(hex('#f1d9a8'), hex('#120c07'), 0.55));
    var key = new THREE.DirectionalLight(hex('#ffd9a0'), 1.35); key.position.set(70, 90, 110); key.target = target; cam.add(key);
    var rim = new THREE.DirectionalLight(hex('#9fc7ae'), 0.95); rim.position.set(-120, 60, -160); rim.target = target; cam.add(rim);
    var fill = new THREE.DirectionalLight(hex('#e0a84a'), 0.3); fill.position.set(-90, -10, 60); fill.target = target; cam.add(fill);

    var fibre = fibreTexture(), mats = { group: {} };
    mats.core = new THREE.MeshStandardMaterial({ color: hex('#3a1f18'), roughness: 0.85, metalness: 0 });
    mats.bone = new THREE.MeshStandardMaterial({ color: hex('#6d5a42'), roughness: 0.7, metalness: 0.05 });
    mats.stone = new THREE.MeshStandardMaterial({ color: hex('#221a12'), roughness: 0.95 });
    mats.brass = new THREE.MeshStandardMaterial({ color: hex('#c99442'), roughness: 0.35, metalness: 0.75 });
    Object.keys(GROUPS).forEach(function (g) { mats.group[g] = new THREE.MeshStandardMaterial({ color: rampColor(0), roughness: 0.48, metalness: 0.06, bumpMap: fibre, bumpScale: 0.05 }); });

    var fig = null, sets = {}, selected = null, hover = null;
    var yaw = -0.42, pitch = 0.06, dist = 175, H = 70;
    function place() {
      target.position.set(0, H * 0.5, 0);
      cam.position.set(Math.sin(yaw) * Math.cos(pitch) * dist, H * 0.5 + Math.sin(pitch) * dist, Math.cos(yaw) * Math.cos(pitch) * dist);
      cam.lookAt(target.position);
    }
    function draw() { place(); renderer.render(scene, cam); }
    function size() {
      var w = el.clientWidth, h = el.clientHeight; if (!w || !h) return;
      renderer.setSize(w, h, false); cam.aspect = w / h;
      var halfH = (H * 0.56) / Math.tan(cam.fov * Math.PI / 360);
      var halfW = (H * 0.4) / Math.tan(cam.fov * Math.PI / 360) / cam.aspect;
      dist = Math.max(halfH, halfW); cam.updateProjectionMatrix(); draw();
    }
    function paint() {
      Object.keys(GROUPS).forEach(function (g) {
        var m = mats.group[g], tt = Math.min(1, (sets[g] || 0) / 10);
        m.color.copy(rampColor(tt));
        // Selection and hover glow verdigris, so they never read as more sets on the brass scale.
        if (g === selected) m.emissive.copy(hex('#8fd0b0')).multiplyScalar(0.55);
        else if (g === hover) m.emissive.copy(hex('#8fd0b0')).multiplyScalar(0.25);
        else m.emissive.copy(hex('#e0a84a')).multiplyScalar(0.1 * tt);
      });
      draw();
    }

    // Turning: drag sideways (vertical drags still scroll the page on a phone); a tap selects.
    var drag = null, ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), anim = null;
    function pick(ev) {
      var r = cv.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, cam);
      var hit = fig ? ray.intersectObjects(fig.meshes, false)[0] : null;
      return hit ? hit.object.userData.group : null;
    }
    cv.addEventListener('pointerdown', function (ev) { drag = { x: ev.clientX, y: ev.clientY, yaw: yaw, pitch: pitch, moved: false, id: ev.pointerId }; });
    cv.addEventListener('pointermove', function (ev) {
      if (drag && drag.id === ev.pointerId) {
        var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 6) { drag.moved = true; if (anim) { cancelAnimationFrame(anim); anim = null; drag.yaw = yaw; } if (opts.onDrag) opts.onDrag(); try { cv.setPointerCapture(ev.pointerId); } catch (e) {} }
        if (drag.moved) { yaw = drag.yaw - dx * 0.011; pitch = Math.max(-0.3, Math.min(0.45, drag.pitch + dy * 0.004)); draw(); }
        return;
      }
      if (ev.pointerType !== 'mouse') return;
      var g = pick(ev);
      if (g !== hover) { hover = g; cv.style.cursor = g ? 'pointer' : 'grab'; if (opts.onHover) opts.onHover(g, sets[g] || 0); paint(); }
    });
    function end(ev) {
      if (!drag) return;
      if (!drag.moved) { var g = pick(ev); selected = g; paint(); if (opts.onSelect) opts.onSelect(g); }
      drag = null;
    }
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', function () { drag = null; });
    cv.addEventListener('pointerleave', function () { if (hover) { hover = null; if (opts.onHover) opts.onHover(null); paint(); } });

    function turnTo(y) {
      if (anim) cancelAnimationFrame(anim);
      var from = yaw, to = y; while (to - from > Math.PI) to -= 2 * Math.PI; while (from - to > Math.PI) to += 2 * Math.PI;
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { yaw = to; draw(); return; }
      var t0 = performance.now();
      (function step(now) {
        var t = Math.min(1, (now - t0) / 520), e = 1 - Math.pow(1 - t, 3);
        yaw = from + (to - from) * e; draw();
        anim = t < 1 ? requestAnimationFrame(step) : null;
      })(t0);
    }

    if (window.ResizeObserver) new ResizeObserver(size).observe(el); else window.addEventListener('resize', size);
    return {
      setBody: function (body) {
        if (fig) { scene.remove(fig.group); fig.group.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); }
        fig = buildFigure(body, mats, fibre); H = fig.height; scene.add(fig.group); size(); paint();
      },
      setSets: function (s) { sets = s || {}; paint(); },
      select: function (g) { selected = g; paint(); },
      view: function (name) { turnTo({ front: 0, side: -Math.PI / 2, back: Math.PI, three: -0.42 }[name] || 0); }
    };
  }

  window.SelfHubBody3D = { GROUPS: GROUPS, mount: mount };
})();
