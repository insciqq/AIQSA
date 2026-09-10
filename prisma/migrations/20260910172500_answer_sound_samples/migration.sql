ALTER TABLE "UserSettings"
  DROP CONSTRAINT "UserSettings_answerSoundId_check",
  ADD CONSTRAINT "UserSettings_answerSoundId_check"
    CHECK ("answerSoundId" IN (
      'rise', 'bell', 'drop', 'double-tap',
      'soft-bell', 'warm-success', 'marimba', 'gentle-pop',
      'minimal-confirm', 'liquid-bubble'
    ));
