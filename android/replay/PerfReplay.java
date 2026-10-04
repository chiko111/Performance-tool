import android.os.SystemClock;
import android.view.InputDevice;
import android.view.InputEvent;
import android.view.MotionEvent;
import java.io.BufferedReader;
import java.io.FileReader;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

/**
 * Plays a recorded touch scenario on the device, started by the server with
 * `CLASSPATH=perf-replay.dex app_process / PerfReplay <events file>`.
 *
 * `adb shell input` starts a new VM for every command (hundreds of ms) and can only draw a
 * straight swipe at an even speed. Running in one process and injecting every recorded touch
 * frame on its own time keeps the timing, the path and the release speed of each gesture, so
 * scrolls and flings stop where they stopped when the person recorded them.
 *
 * Events file, one touch frame per line: "D|M|U <ms from start> <x> <y> <gesture number>".
 * Prints "ready" before the first frame is due and "step <gesture number>" when a gesture starts.
 */
public final class PerfReplay {
  private static final int INJECT_MODE_ASYNC = 0;

  private static final class Frame {
    final int action;
    final long at;
    final float x;
    final float y;
    final String gesture;

    Frame(int action, long at, float x, float y, String gesture) {
      this.action = action;
      this.at = at;
      this.x = x;
      this.y = y;
      this.gesture = gesture;
    }
  }

  public static void main(String[] args) throws Exception {
    Object inputManager;
    try {
      // Android 14+
      inputManager = Class.forName("android.hardware.input.InputManagerGlobal").getMethod("getInstance").invoke(null);
    } catch (ClassNotFoundException olderAndroid) {
      inputManager = Class.forName("android.hardware.input.InputManager").getMethod("getInstance").invoke(null);
    }
    Method inject = inputManager.getClass().getMethod("injectInputEvent", InputEvent.class, int.class);

    List<Frame> frames = read(args[0]);
    System.out.println("ready");
    System.out.flush();

    long start = SystemClock.uptimeMillis();
    long downTime = start;
    for (Frame frame : frames) {
      long at = start + frame.at;
      long wait = at - SystemClock.uptimeMillis();
      if (wait > 0) Thread.sleep(wait);
      if (frame.action == MotionEvent.ACTION_DOWN) {
        downTime = at;
        System.out.println("step " + frame.gesture);
        System.out.flush();
      }
      // The recorded time, not the moment of sending, so the velocity Android computes for a
      // fling stays the recorded one even when a frame goes out a millisecond late.
      MotionEvent event = MotionEvent.obtain(downTime, at, frame.action, frame.x, frame.y, 0);
      event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
      inject.invoke(inputManager, event, INJECT_MODE_ASYNC);
      event.recycle();
    }
    System.out.println("done");
    System.out.flush();
  }

  private static List<Frame> read(String file) throws Exception {
    List<Frame> frames = new ArrayList<>();
    try (BufferedReader reader = new BufferedReader(new FileReader(file))) {
      String line;
      while ((line = reader.readLine()) != null) {
        String[] parts = line.trim().split("\\s+");
        if (parts.length < 5) continue;
        int action =
            parts[0].equals("D") ? MotionEvent.ACTION_DOWN
            : parts[0].equals("U") ? MotionEvent.ACTION_UP
            : MotionEvent.ACTION_MOVE;
        frames.add(new Frame(action, Long.parseLong(parts[1]), Float.parseFloat(parts[2]), Float.parseFloat(parts[3]), parts[4]));
      }
    }
    return frames;
  }
}
