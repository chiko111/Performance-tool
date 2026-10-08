// Native side of the live performance probe. Compiled into a static library by `perf ios` and
// force-loaded into the app only for that build (via an -xcconfig override), so the project is
// never modified. Starts itself on launch, samples every thread's CPU time, main-thread frame
// pacing and memory footprint once per second and POSTs them to the perf server on the Mac.

#import <Foundation/Foundation.h>
#import <QuartzCore/QuartzCore.h>
#import <UIKit/UIKit.h>
#import <mach/mach.h>
#import <objc/runtime.h>
#import <os/lock.h>
#import <pthread.h>
#import <sys/sysctl.h>
#import <sys/utsname.h>

#import "PerfProbeHosts.h" // generated: kPerfProbeHosts, kPerfProbePort

@interface PerfProbeNative : NSObject
- (void)recordTouchesOf:(UIEvent *)event inWindow:(UIWindow *)window;
@end

static PerfProbeNative *sharedProbe;

// ---------- Gesture capture (for automatic before/after replays) ----------
// Every finished one-finger gesture is sent to the server: start/end point in window points, how
// long it took, the release speed, and when it began relative to the app process start. The server
// keeps them only while a scenario capture is running.

static void (*originalSendEvent)(id, SEL, UIEvent *);

static void perfProbeSendEvent(UIWindow *window, SEL selector, UIEvent *event)
{
  [sharedProbe recordTouchesOf:event inWindow:window];
  originalSendEvent(window, selector, event);
}

static double processStartEpochMs(void)
{
  struct kinfo_proc info;
  size_t size = sizeof(info);
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()};
  if (sysctl(mib, 4, &info, &size, NULL, 0) != 0) {
    return 0;
  }
  return info.kp_proc.p_starttime.tv_sec * 1000.0 + info.kp_proc.p_starttime.tv_usec / 1000.0;
}

@implementation PerfProbeNative {
  dispatch_queue_t _queue;
  dispatch_source_t _timer;
  CADisplayLink *_displayLink;
  NSURL *_endpoint;
  BOOL _discovering;
  NSUInteger _ticksWithoutServer;
  NSURLSession *_session;
  NSMutableDictionary<NSNumber *, NSNumber *> *_lastCpuMicros;
  mach_port_t _mainThread;
  CFTimeInterval _lastFrameTimestamp;
  NSUInteger _frames;
  NSUInteger _hitches;
  double _hitchMs;
  double _worstFrameMs;
  NSInteger _maxFps;
  os_unfair_lock _frameLock;
  double _processStartMs;
  NSString *_model;
  UITouch *_touch;
  double _touchDownMs;
  CGPoint _touchStart;
  NSMutableArray<NSValue *> *_recentPoints; // {x, y} with the time in _recentTimes
  NSMutableArray<NSNumber *> *_recentTimes;
}

+ (void)load
{
  Method sendEvent = class_getInstanceMethod(UIWindow.class, @selector(sendEvent:));
  originalSendEvent = (void *)method_setImplementation(sendEvent, (IMP)perfProbeSendEvent);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    sharedProbe = [PerfProbeNative new];
    [sharedProbe start];
  });
}

- (void)start
{
  _mainThread = mach_thread_self();
  _frameLock = OS_UNFAIR_LOCK_INIT;
  _lastCpuMicros = [NSMutableDictionary new];
  _maxFps = UIScreen.mainScreen.maximumFramesPerSecond;
  _processStartMs = processStartEpochMs();
  struct utsname system;
  uname(&system);
  _model = [NSString stringWithUTF8String:system.machine];
  _recentPoints = [NSMutableArray new];
  _recentTimes = [NSMutableArray new];

  NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration ephemeralSessionConfiguration];
  configuration.timeoutIntervalForRequest = 2;
  _session = [NSURLSession sessionWithConfiguration:configuration];

  _displayLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(onFrame:)];
  _displayLink.preferredFrameRateRange = CAFrameRateRangeMake(_maxFps, _maxFps, _maxFps);
  [_displayLink addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];

  _queue = dispatch_queue_create("perfprobe.sampler", DISPATCH_QUEUE_SERIAL);
  _timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _queue);
  dispatch_source_set_timer(_timer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC, NSEC_PER_SEC / 20);
  __weak PerfProbeNative *weakSelf = self;
  dispatch_source_set_event_handler(_timer, ^{
    [weakSelf sample];
  });
  dispatch_resume(_timer);
}

- (void)recordTouchesOf:(UIEvent *)event inWindow:(UIWindow *)window
{
  if (event.type != UIEventTypeTouches) {
    return;
  }
  double nowMs = [NSDate date].timeIntervalSince1970 * 1000.0;
  for (UITouch *touch in [event touchesForWindow:window]) {
    if (_touch != nil && touch != _touch) {
      continue; // only the first finger
    }
    CGPoint point = [touch locationInView:nil];
    if (touch.phase == UITouchPhaseBegan && _touch == nil) {
      _touch = touch;
      _touchDownMs = nowMs;
      _touchStart = point;
      [_recentPoints removeAllObjects];
      [_recentTimes removeAllObjects];
    }
    if (touch != _touch) {
      continue;
    }
    [_recentPoints addObject:[NSValue valueWithCGPoint:point]];
    [_recentTimes addObject:@(nowMs)];
    while (_recentTimes.count > 2 && nowMs - _recentTimes.firstObject.doubleValue > 80) {
      [_recentPoints removeObjectAtIndex:0];
      [_recentTimes removeObjectAtIndex:0];
    }
    if (touch.phase == UITouchPhaseEnded || touch.phase == UITouchPhaseCancelled) {
      CGPoint first = _recentPoints.firstObject.CGPointValue;
      double spanMs = nowMs - _recentTimes.firstObject.doubleValue;
      double releaseSpeed = spanMs > 0 ? hypot(point.x - first.x, point.y - first.y) / (spanMs / 1000.0) : 0;
      CGSize screen = window.bounds.size;
      [self sendGesture:@{
        @"platform" : @"ios",
        @"at" : @(round(_touchDownMs - _processStartMs)),
        @"x1" : @(round(_touchStart.x)),
        @"y1" : @(round(_touchStart.y)),
        @"x2" : @(round(point.x)),
        @"y2" : @(round(point.y)),
        @"durationMs" : @(round(nowMs - _touchDownMs)),
        @"releaseSpeed" : @(round(releaseSpeed)),
        @"device" : @{@"model" : _model, @"width" : @(screen.width), @"height" : @(screen.height), @"density" : @1}
      }];
      _touch = nil;
    }
  }
}

- (void)sendGesture:(NSDictionary *)gesture
{
  dispatch_async(_queue, ^{
    if (self->_endpoint == nil) {
      return;
    }
    NSURL *url = [NSURL URLWithString:@"/gesture" relativeToURL:self->_endpoint];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = @"POST";
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    request.HTTPBody = [NSJSONSerialization dataWithJSONObject:gesture options:0 error:nil];
    [[self->_session dataTaskWithRequest:request] resume];
  });
}

- (void)onFrame:(CADisplayLink *)link
{
  double expectedMs = (link.targetTimestamp - link.timestamp) * 1000.0;
  os_unfair_lock_lock(&_frameLock);
  if (_lastFrameTimestamp > 0) {
    double frameMs = (link.timestamp - _lastFrameTimestamp) * 1000.0;
    if (frameMs > _worstFrameMs) {
      _worstFrameMs = frameMs;
    }
    if (frameMs > expectedMs * 1.5) {
      _hitches += 1;
      _hitchMs += frameMs - expectedMs;
    }
  }
  _lastFrameTimestamp = link.timestamp;
  _frames += 1;
  os_unfair_lock_unlock(&_frameLock);
}

// Tries every host the Mac was reachable on at build time; the first /ping that answers wins.
- (void)discoverServer
{
  if (_discovering) {
    return;
  }
  _discovering = YES;
  NSArray<NSString *> *hosts = [kPerfProbeHosts componentsSeparatedByString:@","];
  __block NSUInteger pending = hosts.count;
  for (NSString *host in hosts) {
    NSString *base = [NSString stringWithFormat:@"http://%@:%d", host, kPerfProbePort];
    NSURL *ping = [NSURL URLWithString:[base stringByAppendingString:@"/ping"]];
    [[_session dataTaskWithURL:ping
             completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
               dispatch_async(self->_queue, ^{
                 NSInteger status = [(NSHTTPURLResponse *)response statusCode];
                 if (error == nil && status == 200 && self->_endpoint == nil) {
                   self->_endpoint = [NSURL URLWithString:[base stringByAppendingString:@"/native"]];
                 }
                 pending -= 1;
                 if (pending == 0) {
                   self->_discovering = NO;
                 }
               });
             }] resume];
  }
}

- (NSString *)nameForThread:(thread_act_t)thread
{
  if (thread == _mainThread) {
    return @"Main Thread";
  }
  pthread_t pthread = pthread_from_mach_thread_np(thread);
  char name[256] = {0};
  if (pthread != NULL && pthread_getname_np(pthread, name, sizeof(name)) == 0 && name[0] != '\0') {
    return [NSString stringWithUTF8String:name];
  }
  return @"(unnamed threads)";
}

// Names the device in the dashboard's device list. A simulator reports "arm64" as its machine, so
// its model and name come from the environment the simulator gives the process.
- (NSDictionary *)deviceInfo
{
#if TARGET_OS_SIMULATOR
  NSDictionary<NSString *, NSString *> *environment = NSProcessInfo.processInfo.environment;
  return @{
    @"simulator" : @YES,
    @"model" : environment[@"SIMULATOR_MODEL_IDENTIFIER"] ?: _model,
    @"name" : environment[@"SIMULATOR_DEVICE_NAME"] ?: @""
  };
#else
  return @{@"simulator" : @NO, @"model" : _model};
#endif
}

- (void)sample
{
  thread_act_array_t threads;
  mach_msg_type_number_t threadCount = 0;
  if (task_threads(mach_task_self(), &threads, &threadCount) != KERN_SUCCESS) {
    return;
  }

  NSMutableDictionary<NSString *, NSNumber *> *cpuByName = [NSMutableDictionary new];
  NSMutableDictionary<NSNumber *, NSNumber *> *seen = [NSMutableDictionary new];
  double totalMs = 0;

  for (mach_msg_type_number_t index = 0; index < threadCount; index++) {
    thread_act_t thread = threads[index];
    thread_basic_info_data_t basic;
    mach_msg_type_number_t basicCount = THREAD_BASIC_INFO_COUNT;
    thread_identifier_info_data_t identifier;
    mach_msg_type_number_t identifierCount = THREAD_IDENTIFIER_INFO_COUNT;

    if (thread_info(thread, THREAD_BASIC_INFO, (thread_info_t)&basic, &basicCount) == KERN_SUCCESS &&
        thread_info(thread, THREAD_IDENTIFIER_INFO, (thread_info_t)&identifier, &identifierCount) == KERN_SUCCESS) {
      uint64_t micros = (uint64_t)basic.user_time.seconds * 1000000 + basic.user_time.microseconds +
          (uint64_t)basic.system_time.seconds * 1000000 + basic.system_time.microseconds;
      NSNumber *threadId = @(identifier.thread_id);
      NSNumber *previous = _lastCpuMicros[threadId];
      seen[threadId] = @(micros);
      if (previous != nil && micros >= previous.unsignedLongLongValue) {
        double deltaMs = (micros - previous.unsignedLongLongValue) / 1000.0;
        NSString *name = [self nameForThread:thread];
        cpuByName[name] = @(cpuByName[name].doubleValue + deltaMs);
        totalMs += deltaMs;
      }
    }
    mach_port_deallocate(mach_task_self(), thread);
  }
  vm_deallocate(mach_task_self(), (vm_address_t)threads, threadCount * sizeof(thread_act_t));
  _lastCpuMicros = seen;

  task_vm_info_data_t vmInfo;
  mach_msg_type_number_t vmCount = TASK_VM_INFO_COUNT;
  double footprintMb = 0;
  if (task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&vmInfo, &vmCount) == KERN_SUCCESS) {
    footprintMb = vmInfo.phys_footprint / (1024.0 * 1024.0);
  }

  os_unfair_lock_lock(&_frameLock);
  NSDictionary *frames = @{
    @"fps" : @(_frames),
    @"maxFps" : @(_maxFps),
    @"hitches" : @(_hitches),
    @"hitchMs" : @(round(_hitchMs)),
    @"worstFrameMs" : @(round(_worstFrameMs))
  };
  _frames = 0;
  _hitches = 0;
  _hitchMs = 0;
  _worstFrameMs = 0;
  os_unfair_lock_unlock(&_frameLock);

  if (_endpoint == nil) {
    if (_ticksWithoutServer++ % 5 == 0) {
      [self discoverServer];
    }
    return;
  }

  NSMutableArray *threadList = [NSMutableArray new];
  [cpuByName enumerateKeysAndObjectsUsingBlock:^(NSString *name, NSNumber *ms, BOOL *stop) {
    [threadList addObject:@{@"name" : name, @"cpuMs" : @(round(ms.doubleValue * 10) / 10)}];
  }];

  NSDictionary *payload = @{
    @"platform" : @"ios",
    @"t" : @((long long)([NSDate date].timeIntervalSince1970 * 1000)),
    @"cpuMs" : @(round(totalMs)),
    @"threads" : threadList,
    @"ui" : frames,
    @"memoryMb" : @(round(footprintMb * 10) / 10),
    // iOS exposes no temperature, only the thermal state: 0 nominal, 1 fair, 2 serious, 3 critical.
    @"thermal" : @{@"state" : @(NSProcessInfo.processInfo.thermalState)},
    @"device" : [self deviceInfo]
  };

  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:_endpoint];
  request.HTTPMethod = @"POST";
  [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
  request.HTTPBody = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  [[_session dataTaskWithRequest:request
               completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
                 if (error != nil) {
                   dispatch_async(self->_queue, ^{
                     self->_endpoint = nil; // server restarted or Mac changed network: rediscover
                   });
                 }
               }] resume];
}

@end
