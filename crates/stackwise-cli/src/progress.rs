use std::borrow::Cow;
use std::io::{self, IsTerminal};
use std::time::Duration;

use indicatif::{ProgressBar, ProgressDrawTarget, ProgressStyle};

const TICK_INTERVAL: Duration = Duration::from_millis(120);

/// Terminal-aware progress indicator for the analysis pipeline.
///
/// Renders a stderr spinner only when stderr is attached to a terminal so
/// that piped output, CI runs, and tests stay quiet.
pub(crate) struct AnalysisProgress {
    bar: ProgressBar,
}

impl AnalysisProgress {
    pub(crate) fn new() -> Self {
        let bar = ProgressBar::with_draw_target(None, draw_target());
        bar.set_style(spinner_style());
        bar.enable_steady_tick(TICK_INTERVAL);
        Self { bar }
    }

    pub(crate) fn set_stage(&self, message: impl Into<Cow<'static, str>>) {
        self.bar.set_message(message);
    }

    pub(crate) fn finish(&self) {
        self.bar.finish_and_clear();
    }
}

impl Drop for AnalysisProgress {
    fn drop(&mut self) {
        // Safety net for early returns so the spinner never lingers above
        // an error message or a follow-up println.
        self.bar.finish_and_clear();
    }
}

fn draw_target() -> ProgressDrawTarget {
    if io::stderr().is_terminal() {
        ProgressDrawTarget::stderr()
    } else {
        ProgressDrawTarget::hidden()
    }
}

fn spinner_style() -> ProgressStyle {
    ProgressStyle::with_template("{spinner:.cyan} {msg}")
        .unwrap_or_else(|_| ProgressStyle::default_spinner())
}
