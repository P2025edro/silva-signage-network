import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface EnvInfo {
  demo?: boolean;
  videoUploads?: boolean;
  maxImageBytes?: number;
}

/** What this deployment supports (demo banner, video, upload size). */
export const useEnvInfo = () => useQuery({ queryKey: ['env-info'], queryFn: () => api.get<EnvInfo>('/api/health'), staleTime: Infinity });
