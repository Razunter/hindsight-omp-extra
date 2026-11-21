import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerCuration } from "./curation";
import { registerEvidence } from "./evidence";
import { registerLocalManagement } from "./local-management";
import { registerMentalModelMonitor } from "./mental-model-monitor";
import { registerRecallAssistance } from "./recall-assistance";

/**
 * OMP extension factory. Evidence, curation, recall assistance, mental-model monitoring and local management register independently.
 */
export default function hindsightPlugin(pi: ExtensionAPI): void {
    pi.setLabel("Hindsight");
    registerEvidence(pi);
    registerCuration(pi);
    registerRecallAssistance(pi);
    registerMentalModelMonitor(pi);
    registerLocalManagement(pi);
}
