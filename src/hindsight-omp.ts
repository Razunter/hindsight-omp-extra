import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerEvidence } from "./evidence";
import { registerLocalManagement } from "./local-management";
import { registerMentalModelMonitor } from "./mental-model-monitor";
import { registerRecallAssistance } from "./recall-assistance";

/**
 * OMP extension factory. Evidence, recall assistance, mental model monitoring and optional local management register independently.
 */
export default function hindsightPlugin(pi: ExtensionAPI): void {
    pi.setLabel("Hindsight");
    registerEvidence(pi);
    registerRecallAssistance(pi);
    registerMentalModelMonitor(pi);
    registerLocalManagement(pi);
}
