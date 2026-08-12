// Prevents an extra console window when launching the Windows release binary.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    fund_tracker_lib::run();
}
