CREATE VIRTUAL TABLE `job_events_fts` USING fts5(`payload`, content=`job_events`, content_rowid=`id`);--> statement-breakpoint
CREATE TRIGGER `job_events_fts_ai` AFTER INSERT ON `job_events` BEGIN
  INSERT INTO `job_events_fts`(`rowid`, `payload`) VALUES (new.`id`, new.`payload`);
END;--> statement-breakpoint
CREATE TRIGGER `job_events_fts_ad` AFTER DELETE ON `job_events` BEGIN
  INSERT INTO `job_events_fts`(`job_events_fts`, `rowid`, `payload`) VALUES ('delete', old.`id`, old.`payload`);
END;--> statement-breakpoint
CREATE TRIGGER `job_events_fts_au` AFTER UPDATE ON `job_events` BEGIN
  INSERT INTO `job_events_fts`(`job_events_fts`, `rowid`, `payload`) VALUES ('delete', old.`id`, old.`payload`);
  INSERT INTO `job_events_fts`(`rowid`, `payload`) VALUES (new.`id`, new.`payload`);
END;--> statement-breakpoint
INSERT INTO `job_events_fts`(`rowid`, `payload`) SELECT `id`, `payload` FROM `job_events`;
