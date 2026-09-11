// Keep the versioned desktop API alias during rollout.  Both paths use the
// same strict PAT-authenticated handler and therefore cannot diverge in
// authorization or external-id semantics.
export {
  DELETE,
  GET,
  PUT,
} from "../../../chat/feedback/route";
