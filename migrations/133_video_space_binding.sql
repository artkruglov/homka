-- Video receipts appeared after the frozen 104 catalog. Keep their immutable area just
-- like image receipts, without a workspace FK: billing survives workspace deletion.
-- Existing legacy rows are bound by the normal late-binding operator after duplicate
-- roots are reconciled. This migration does not guess an audience or switch runtime mode.
ALTER TABLE video_generation_operations ADD COLUMN space_id uuid;
ALTER TABLE video_generation_operations ADD CONSTRAINT video_generation_operations_space_id_fkey
  FOREIGN KEY(space_id) REFERENCES spaces(id) ON DELETE SET NULL (space_id)
  DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX video_generation_operations_space_id_idx ON video_generation_operations(space_id);
CREATE TRIGGER space_record_boundary_guard BEFORE UPDATE OF space_id ON video_generation_operations
  FOR EACH ROW EXECUTE FUNCTION guard_space_record_boundary();
