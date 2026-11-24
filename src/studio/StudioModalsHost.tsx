import React from 'react';
import { RenderExportModal } from '../components/RenderExportModal';
import { AsrResearchLabModal } from '../components/AsrResearchLabModal';
import { SpeechSecurityModal } from '../components/SpeechSecurityModal';
import { DeveloperPlatformPortalModal } from '../components/DeveloperPlatformPortalModal';
import { NewProjectModal } from '../components/NewProjectModal';
import { SettingsCenterModal } from '../components/SettingsCenterModal';
import { ShortcutsCheatSheetModal } from '../components/ShortcutsCheatSheetModal';
import { LifecycleManagementModal } from '../components/LifecycleManagementModal';

export interface StudioModalsHostProps {
  appView: 'projects' | 'studio';
  isLabMode: boolean;
  locale: 'fa' | 'en';
  persianDigits: boolean;
  renderExportProps?: React.ComponentProps<typeof RenderExportModal>;
  asrResearchLabProps?: React.ComponentProps<typeof AsrResearchLabModal>;
  speechSecurityProps?: React.ComponentProps<typeof SpeechSecurityModal>;
  developerPortalProps?: React.ComponentProps<typeof DeveloperPlatformPortalModal>;
  newProjectProps: React.ComponentProps<typeof NewProjectModal>;
  settingsProps: React.ComponentProps<typeof SettingsCenterModal>;
  shortcutsProps: React.ComponentProps<typeof ShortcutsCheatSheetModal>;
  lifecycleProps: React.ComponentProps<typeof LifecycleManagementModal>;
}

export const StudioModalsHost: React.FC<StudioModalsHostProps> = ({
  appView,
  isLabMode,
  renderExportProps,
  asrResearchLabProps,
  speechSecurityProps,
  developerPortalProps,
  newProjectProps,
  settingsProps,
  shortcutsProps,
  lifecycleProps,
}) => {
  return (
    <>
      {appView === 'studio' && renderExportProps && (
        <RenderExportModal {...renderExportProps} />
      )}

      {appView === 'studio' && isLabMode && (
        <>
          {asrResearchLabProps && <AsrResearchLabModal {...asrResearchLabProps} />}
          {speechSecurityProps && <SpeechSecurityModal {...speechSecurityProps} />}
          {developerPortalProps && <DeveloperPlatformPortalModal {...developerPortalProps} />}
        </>
      )}

      <NewProjectModal {...newProjectProps} />
      <SettingsCenterModal {...settingsProps} />
      <ShortcutsCheatSheetModal {...shortcutsProps} />
      <LifecycleManagementModal {...lifecycleProps} />
    </>
  );
};
