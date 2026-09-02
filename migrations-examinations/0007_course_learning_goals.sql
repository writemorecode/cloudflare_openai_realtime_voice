ALTER TABLE courses
  ADD COLUMN learning_goals TEXT
  CHECK (learning_goals IS NULL OR length(learning_goals) <= 4000);
