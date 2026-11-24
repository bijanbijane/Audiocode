import React from 'react';
import { ProcessingGraphView } from '../components/ProcessingGraphView';
import { StorageBrokerView } from '../components/StorageBrokerView';
import { ShahabLabView } from '../components/ShahabLabView';
import type { WorkspaceTab } from '../components/HeaderNav';
import type {
  AudioAsset,
  ProcessingGraphEdge,
  ProcessingNodeDescriptor,
  RuntimeCapabilities,
  StorageBrokerTelemetry,
} from '../contracts/v1_2';

export interface StudioLabRouterViewProps {
  activeTab: Exclude<WorkspaceTab, 'studio'>;
  graphNodes: ProcessingNodeDescriptor[];
  graphEdges: ProcessingGraphEdge[];
  sampleRate: number;
  resamplerStats: React.ComponentProps<typeof ProcessingGraphView>['resamplerStats'];
  onToggleNodeBypass: (nodeId: string) => void;
  capabilities: RuntimeCapabilities;
  telemetry: StorageBrokerTelemetry;
  assets: Record<string, AudioAsset>;
  isTestingLru: boolean;
  onRunBrokerConcurrencyTest: () => void;
  onSimulateLruCacheFill: () => void;
  locale: 'fa' | 'en';
  persianDigits: boolean;
}

export const StudioLabRouterView: React.FC<StudioLabRouterViewProps> = ({
  activeTab,
  graphNodes,
  graphEdges,
  sampleRate,
  resamplerStats,
  onToggleNodeBypass,
  capabilities,
  telemetry,
  assets,
  isTestingLru,
  onRunBrokerConcurrencyTest,
  onSimulateLruCacheFill,
  locale,
  persianDigits,
}) => {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto max-w-[1440px] w-full mx-auto px-4 py-4">
      {activeTab === 'graph' && (
        <ProcessingGraphView
          nodes={graphNodes}
          edges={graphEdges}
          sampleRate={sampleRate}
          resamplerStats={resamplerStats}
          onToggleNodeBypass={onToggleNodeBypass}
          locale={locale}
          persianDigits={persianDigits}
        />
      )}

      {activeTab === 'storage' && (
        <StorageBrokerView
          capabilities={capabilities}
          telemetry={telemetry}
          assets={assets}
          isTestingLru={isTestingLru}
          onRunBrokerConcurrencyTest={onRunBrokerConcurrencyTest}
          onSimulateLruCacheFill={onSimulateLruCacheFill}
          locale={locale}
          persianDigits={persianDigits}
        />
      )}

      {activeTab === 'shahab' && (
        <ShahabLabView locale={locale} persianDigits={persianDigits} />
      )}
    </div>
  );
};
