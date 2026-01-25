# AtFactoryPrice Mobile App

Flutter mobile application for AtFactoryPrice e-commerce platform with MLM features.

## Features

- **Product Catalog**: Browse products with search, filter, and sort
- **Shopping Cart**: Add to cart, update quantities, checkout
- **User Authentication**: Login, signup with referral codes
- **Reward Points**: View and track MLM reward points
- **Referral System**: Share referral codes to earn points
- **Profile Management**: User profile with referral sharing

## Setup Instructions

### Prerequisites

1. **Flutter SDK** (3.0.0 or higher)
   ```bash
   flutter --version
   ```

2. **Firebase CLI**
   ```bash
   npm install -g firebase-tools
   firebase login
   ```

### Configuration

1. **Clone the repository**
   ```bash
   cd mobile
   ```

2. **Install dependencies**
   ```bash
   flutter pub get
   ```

3. **Configure Firebase**
   
   - Go to [Firebase Console](https://console.firebase.google.com)
   - Select your project (atfactoryprice-6ba8f)
   - Add Android and iOS apps
   - Download config files:
     - Android: `google-services.json` → `android/app/`
     - iOS: `GoogleService-Info.plist` → `ios/Runner/`

4. **Update Firebase Options**
   
   Edit `lib/config/firebase_options.dart` with your actual values from Firebase Console.

### Running the App

**Development:**
```bash
flutter run
```

**Build APK:**
```bash
flutter build apk --release
```

**Build App Bundle:**
```bash
flutter build appbundle --release
```

**Build iOS:**
```bash
flutter build ios --release
```

## Project Structure

```
mobile/
├── lib/
│   ├── config/           # App configuration
│   │   ├── app_theme.dart
│   │   └── firebase_options.dart
│   ├── models/           # Data models
│   │   ├── product.dart
│   │   └── cart_item.dart
│   ├── services/         # Business logic
│   │   ├── auth_service.dart
│   │   ├── cart_service.dart
│   │   ├── product_service.dart
│   │   └── points_service.dart
│   ├── screens/          # UI screens
│   │   ├── auth/
│   │   ├── home/
│   │   ├── products/
│   │   ├── cart/
│   │   ├── points/
│   │   └── profile/
│   ├── widgets/          # Reusable widgets
│   └── main.dart         # App entry point
├── assets/               # Static assets
├── android/              # Android specific
├── ios/                  # iOS specific
└── pubspec.yaml          # Dependencies
```

## Firebase Collections Used

- `users` - User profiles
- `products` - Product catalog
- `orders` - Order history
- `referral_codes` - Public referral codes
- `mlm_points_wallet` - User points balance
- `mlm_points_ledger` - Points transactions

## Security Notes

- All wallet operations go through Cloud Functions
- No client-side points manipulation
- Secure referral code validation
- Offline browsing supported (read-only)

## Building for Release

### Android

1. Generate signing key:
   ```bash
   keytool -genkey -v -keystore upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
   ```

2. Create `android/key.properties`:
   ```
   storePassword=<password>
   keyPassword=<password>
   keyAlias=upload
   storeFile=upload-keystore.jks
   ```

3. Build release:
   ```bash
   flutter build appbundle --release
   ```

### iOS

1. Open `ios/Runner.xcworkspace` in Xcode
2. Configure signing certificates
3. Build archive for distribution

## Troubleshooting

**Firebase not connecting:**
- Ensure config files are in correct locations
- Check Firebase project settings match

**Build errors:**
- Run `flutter clean && flutter pub get`
- Check Flutter version compatibility

**Offline mode issues:**
- Products load from Firestore cache when offline
- Checkout disabled when offline
