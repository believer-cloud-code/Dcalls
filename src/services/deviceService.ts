export type Platform = 'web' | 'android' | 'ios' | 'electron';

class DeviceService {
  getPlatform(): Platform {
    const userAgent = navigator.userAgent.toLowerCase();
    
    if (userAgent.includes('electron')) {
      return 'electron';
    }
    
    // Capacitor check
    if ((window as any).Capacitor) {
      return (window as any).Capacitor.getPlatform();
    }
    
    return 'web';
  }

  isNative(): boolean {
    const platform = this.getPlatform();
    return platform === 'android' || platform === 'ios';
  }

  isDesktop(): boolean {
    return this.getPlatform() === 'electron';
  }
}

export const deviceService = new DeviceService();
