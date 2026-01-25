import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;
import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;

/// Firebase configuration for AtFactoryPrice
/// 
/// IMPORTANT: Update these values with your actual Firebase project settings
/// Get these from Firebase Console > Project Settings > Your apps
class DefaultFirebaseOptions {
  static FirebaseOptions get currentPlatform {
    if (kIsWeb) {
      return web;
    }
    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return android;
      case TargetPlatform.iOS:
        return ios;
      case TargetPlatform.macOS:
        throw UnsupportedError(
          'DefaultFirebaseOptions have not been configured for macos - '
          'you can reconfigure this by running the FlutterFire CLI again.',
        );
      case TargetPlatform.windows:
        throw UnsupportedError(
          'DefaultFirebaseOptions have not been configured for windows - '
          'you can reconfigure this by running the FlutterFire CLI again.',
        );
      case TargetPlatform.linux:
        throw UnsupportedError(
          'DefaultFirebaseOptions have not been configured for linux - '
          'you can reconfigure this by running the FlutterFire CLI again.',
        );
      default:
        throw UnsupportedError(
          'DefaultFirebaseOptions are not supported for this platform.',
        );
    }
  }

  /// Web configuration
  static const FirebaseOptions web = FirebaseOptions(
    apiKey: 'AIzaSyA3SzcQWEgWv51hA5CsNyj6WG1cp-sZYKA',
    appId: '1:660895645396:web:a4ea1e8febc6e0b7f74541',
    messagingSenderId: '660895645396',
    projectId: 'atfactoryprice-6ba8f',
    authDomain: 'atfactoryprice-6ba8f.firebaseapp.com',
    storageBucket: 'atfactoryprice-6ba8f.firebasestorage.app',
  );

  /// Android configuration
  static const FirebaseOptions android = FirebaseOptions(
    apiKey: 'AIzaSyADjiJiU5e1kd48bDINW69OrqLVo8y_NHE',
    appId: '1:660895645396:android:62549ecff89f753af74541',
    messagingSenderId: '660895645396',
    projectId: 'atfactoryprice-6ba8f',
    storageBucket: 'atfactoryprice-6ba8f.firebasestorage.app',
  );

  /// iOS configuration
  /// TODO: Replace with actual values from GoogleService-Info.plist
  static const FirebaseOptions ios = FirebaseOptions(
    apiKey: 'YOUR_IOS_API_KEY',
    appId: '1:660895645396:ios:YOUR_IOS_APP_ID',
    messagingSenderId: '660895645396',
    projectId: 'atfactoryprice-6ba8f',
    storageBucket: 'atfactoryprice-6ba8f.firebasestorage.app',
    iosBundleId: 'com.atfactoryprice.app',
  );
}
