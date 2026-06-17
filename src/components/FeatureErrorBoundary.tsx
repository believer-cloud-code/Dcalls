import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

interface Props {
    children: ReactNode;
    featureName: string;
    onReset?: () => void;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class FeatureErrorBoundary extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error(`[FeatureErrorBoundary] ${this.props.featureName} error:`, error, errorInfo);
    }

    private handleReset = () => {
        this.setState({ hasError: false, error: null });
        this.props.onReset?.();
    };

    public render() {
        if (this.state.hasError) {
            return (
                <div className="flex flex-col items-center justify-center p-8 space-y-4 bg-red-500/5 border border-red-500/20 rounded-2xl">
                    <div className="flex items-center gap-3">
                        <AlertCircle className="text-red-500" size={24} />
                        <div className="text-left">
                            <h3 className="font-semibold text-red-400">{this.props.featureName} Error</h3>
                            <p className="text-xs text-gray-400 mt-1">
                                {this.state.error?.message || 'An unexpected error occurred'}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={this.handleReset}
                        className="flex items-center gap-2 mt-4 px-4 py-2 bg-red-500 hover:bg-red-600 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                        <RotateCcw size={14} />
                        Try Again
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
