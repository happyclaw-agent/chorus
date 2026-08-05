import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from '@/components/layout/AppShell';
import { PATHS } from '@/constants/path';
import { GroupDetailPage } from '@/pages/GroupDetailPage';
import { GroupsPage } from '@/pages/GroupsPage';
import { LookbooksPage } from '@/pages/LookbooksPage';
import { MonitorPage } from '@/pages/MonitorPage';
import { RunwayPage } from '@/pages/RunwayPage';
import { SourcesPage } from '@/pages/SourcesPage';
import { TraceDetailPage } from '@/pages/TraceDetailPage';
import { TracesPage } from '@/pages/TracesPage';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to={PATHS.TRACES} replace />} />
        <Route path={PATHS.GROUPS} element={<GroupsPage />} />
        <Route path={PATHS.GROUP_DETAIL} element={<GroupDetailPage />} />
        <Route path={PATHS.TRACES} element={<TracesPage />} />
        <Route path={PATHS.TRACE_DETAIL} element={<TraceDetailPage />} />
        <Route path={PATHS.LOOKBOOKS} element={<LookbooksPage />} />
        <Route path={PATHS.RUNWAY} element={<RunwayPage />} />
        <Route path={PATHS.MONITOR} element={<MonitorPage />} />
        <Route path={PATHS.SOURCES} element={<SourcesPage />} />
        <Route path="*" element={<Navigate to={PATHS.TRACES} replace />} />
      </Route>
    </Routes>
  );
}
