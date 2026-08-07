-- The reusable-assistants contract migration dropped RunProfile and therefore
-- its temporary DML/TRUNCATE trigger. Remove the now-unreferenced trigger
-- function after that destructive boundary has completed successfully.
DROP FUNCTION "run_profile_stock_cleanup_write_guard"();
