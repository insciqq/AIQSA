-- Optional Decisions use the same retained credential/model authority as other
-- accepted provider bindings. Absence means disabled for that accepted run.
ALTER TYPE "ProviderRunRole" ADD VALUE 'decision';
