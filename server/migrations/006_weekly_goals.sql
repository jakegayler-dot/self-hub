-- Weekly training-load goals: a floor you set for sessions/week per channel,
-- used alongside the ACWR-based weekly load rating (computed on the fly,
-- not stored) to answer "have I done enough this week."

ALTER TABLE fitness_profile ADD COLUMN IF NOT EXISTS weekly_strength_sessions_goal SMALLINT;
ALTER TABLE fitness_profile ADD COLUMN IF NOT EXISTS weekly_conditioning_sessions_goal SMALLINT;
UPDATE fitness_profile SET weekly_strength_sessions_goal = 4 WHERE weekly_strength_sessions_goal IS NULL;
UPDATE fitness_profile SET weekly_conditioning_sessions_goal = 2 WHERE weekly_conditioning_sessions_goal IS NULL;
ALTER TABLE fitness_profile ALTER COLUMN weekly_strength_sessions_goal SET NOT NULL;
ALTER TABLE fitness_profile ALTER COLUMN weekly_strength_sessions_goal SET DEFAULT 4;
ALTER TABLE fitness_profile ALTER COLUMN weekly_conditioning_sessions_goal SET NOT NULL;
ALTER TABLE fitness_profile ALTER COLUMN weekly_conditioning_sessions_goal SET DEFAULT 2;
