import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerEvidence } from "./evidence";
import { registerLocalManagement } from "./local-management";
import { registerRecallAssistance } from "./recall-assistance";

/**
 * omp extension factory. Evidence, recall assistance and optional local management register independently.
 */
export default function hindsightPlugin(pi: ExtensionAPI): void {
    pi.setLabel("Hindsight");
    registerEvidence(pi);
    registerRecallAssistance(pi);
    registerLocalManagement(pi);
}
