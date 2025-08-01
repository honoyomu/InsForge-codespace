import React, { useState } from 'react';
import AppSidebar from './AppSidebar';
import AppHeader from './AppHeader';
import { cn } from '@/lib/utils/utils';
import { useAuth } from '@/lib/contexts/AuthContext';

interface LayoutProps {
  children: React.ReactNode;
}

export default function Layout({ children }: LayoutProps) {
  const [sidebarMobileOpen, setSidebarMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false); // Default to expanded
  const { user, logout } = useAuth();

  return (
    <div className="h-screen bg-gray-50 flex">
      <AppHeader currentUser={user} onLogout={logout} />

      <AppSidebar
        currentUser={user}
        onLogout={logout}
        isMobileOpen={sidebarMobileOpen}
        onMobileToggle={() => setSidebarMobileOpen(!sidebarMobileOpen)}
        isCollapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />

      {/* Main content */}
      <div
        className={cn(
          'flex-1 transition-all duration-300 ease-in-out overflow-y-auto',
          sidebarCollapsed ? 'lg:ml-[72px]' : 'lg:ml-[240px]',
          'mt-16'
        )}
      >
        {children}
      </div>
    </div>
  );
}
