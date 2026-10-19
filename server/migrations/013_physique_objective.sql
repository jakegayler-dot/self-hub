-- The trainer works out where Jake needs attention from his data, not from a remark (Jake, 2026-10-18: "tiny
-- legs is a passing comment I made; the system should be able to determine objectively if my legs are tiny").
-- Clear the read that was seeded from that remark; the column stays for anything he writes himself.
UPDATE fitness_profile SET physique_assessment = NULL
 WHERE id = 1 AND physique_assessment = 'Big, broad shoulders already and low body fat. Tiny legs and a tiny waist: those are the gaps.';
