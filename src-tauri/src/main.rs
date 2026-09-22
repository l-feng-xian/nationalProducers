// Windows release 下不要多弹一个控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nationalproducers_lib::run()
}
