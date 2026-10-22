-- Record submissions in the campaign review history with their own decision value.
ALTER TYPE review_decision ADD VALUE IF NOT EXISTS 'SUBMIT' BEFORE 'START_REVIEW';
