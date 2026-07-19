import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

/// Authentication Service
/// Handles user login, signup, and session management
class AuthService extends ChangeNotifier {
  final FirebaseAuth _auth = FirebaseAuth.instance;
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;
  
  User? _user;
  Map<String, dynamic>? _userData;
  bool _isLoading = true;
  bool _booted = false;
  String? _error;

  // Getters
  User? get user => _user;
  Map<String, dynamic>? get userData => _userData;
  bool get isLoading => _isLoading;
  /// True only until the FIRST auth-state event. AuthWrapper keys off this
  /// (not isLoading) so a failed sign-in doesn't flash the splash screen
  /// and wipe the login form mid-submit.
  bool get booting => !_booted;
  bool get isAuthenticated => _user != null;
  String? get error => _error;
  String get userId => _user?.uid ?? '';
  String get userEmail => _user?.email ?? '';
  String get displayName => _userData?['name'] ?? _userData?['firstName'] ?? _user?.displayName ?? 'User';
  String? get referralCode => _userData?['referralCode'];
  bool get isAdmin => _userData?['isAdmin'] == true || 
    ['admin@atfactoryprice.com', 'hello@atfactoryprice.com'].contains(userEmail);
  
  AuthService() {
    _init();
  }
  
  /// Initialize auth state listener
  void _init() {
    _auth.authStateChanges().listen((User? user) async {
      _user = user;
      if (user != null) {
        await _loadUserData();
      } else {
        _userData = null;
      }
      _booted = true;
      _isLoading = false;
      notifyListeners();
    });
  }
  
  /// Load user data from Firestore
  Future<void> _loadUserData() async {
    if (_user == null) return;
    
    try {
      final doc = await _firestore.collection('users').doc(_user!.uid).get();
      if (doc.exists) {
        _userData = doc.data();
      }
    } catch (e) {
      debugPrint('Error loading user data: $e');
    }
  }
  
  /// Sign in with email and password
  Future<bool> signIn(String email, String password) async {
    try {
      _isLoading = true;
      _error = null;
      notifyListeners();
      
      await _auth.signInWithEmailAndPassword(
        email: email.trim(),
        password: password,
      );
      
      return true;
    } on FirebaseAuthException catch (e) {
      _error = _getAuthErrorMessage(e.code);
      _isLoading = false;
      notifyListeners();
      return false;
    } catch (e) {
      _error = 'An unexpected error occurred. Please try again.';
      _isLoading = false;
      notifyListeners();
      return false;
    }
  }
  
  /// Sign up with email and password
  Future<bool> signUp({
    required String email,
    required String password,
    required String name,
    String? phone,
    String? referralCode,
  }) async {
    try {
      _isLoading = true;
      _error = null;
      notifyListeners();
      
      // Create auth user
      final credential = await _auth.createUserWithEmailAndPassword(
        email: email.trim(),
        password: password,
      );
      
      if (credential.user != null) {
        final uid = credential.user!.uid;
        // Generate a unique referral code (website scheme: AFP + 6 chars,
        // collision-checked so we never overwrite another user's code).
        final newReferralCode = await _generateReferralCode(uid);

        // Resolve the sponsor BEFORE creating the user doc: the MLM engine
        // attributes referrals via users.sponsorId (write-once in rules) —
        // storing only the typed code would earn the referrer nothing.
        final normalizedSponsorCode = referralCode?.trim().toUpperCase();
        String? sponsorId;
        if (normalizedSponsorCode != null && normalizedSponsorCode.isNotEmpty) {
          final validation = await validateReferralCode(normalizedSponsorCode);
          if (validation?['valid'] == true) {
            sponsorId = validation?['userId'] as String?;
          }
        }

        // Create user document (field set mirrors the website signup —
        // js/auth-ui.js — so backend triggers see one schema).
        await _firestore.collection('users').doc(uid).set({
          'uid': uid,
          'email': email.trim(),
          'name': name.trim(),
          'phone': phone?.trim(),
          'referralCode': newReferralCode,
          'sponsorCode': normalizedSponsorCode,
          if (sponsorId != null) 'sponsorId': sponsorId,
          'isActive': true,
          'accountType': 'customer',
          'createdAt': FieldValue.serverTimestamp(),
          'updatedAt': FieldValue.serverTimestamp(),
        });

        // Save to public referral_codes collection (shape matches the
        // website writer, including the code field).
        await _firestore.collection('referral_codes').doc(newReferralCode).set({
          'code': newReferralCode,
          'userId': uid,
          'userName': name.trim(),
          'isActive': true,
          'createdAt': FieldValue.serverTimestamp(),
        });

        // Wallet doc, same shape as the website signup — commission
        // credits merge into it either way, but reads expect it to exist.
        await _firestore.collection('wallets').doc(uid).set({
          'userId': uid,
          'totalEarned': 0,
          'pending': 0,
          'available': 0,
          'withdrawn': 0,
          'updatedAt': FieldValue.serverTimestamp(),
        });

        await _loadUserData();
        _isLoading = false;
        notifyListeners();
      }

      return true;
    } on FirebaseAuthException catch (e) {
      _error = _getAuthErrorMessage(e.code);
      _isLoading = false;
      notifyListeners();
      return false;
    } catch (e) {
      _error = 'An unexpected error occurred. Please try again.';
      _isLoading = false;
      notifyListeners();
      return false;
    }
  }
  
  /// Generate a unique referral code — website scheme (js/auth-ui.js):
  /// AFP + 6 chars from an unambiguous charset, re-rolled on collision so
  /// an existing user's code is never silently reassigned.
  Future<String> _generateReferralCode(String uid) async {
    const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    final rng = Random();
    String code = '';
    for (var attempt = 0; attempt < 10; attempt++) {
      code = 'AFP${List.generate(6, (_) => charset[rng.nextInt(charset.length)]).join()}';
      final existing = await _firestore.collection('referral_codes').doc(code).get();
      if (!existing.exists) return code;
    }
    return code;
  }

  /// Validate referral code (normalization + tolerance match the website:
  /// trim+uppercase, and a missing isActive counts as active).
  Future<Map<String, dynamic>?> validateReferralCode(String code) async {
    try {
      final doc = await _firestore.collection('referral_codes').doc(code.trim().toUpperCase()).get();
      if (doc.exists && doc.data()?['isActive'] != false) {
        return {
          'valid': true,
          'userId': doc.data()?['userId'],
          'userName': doc.data()?['userName'],
        };
      }
      return {'valid': false};
    } catch (e) {
      debugPrint('Error validating referral code: $e');
      return {'valid': false, 'error': e.toString()};
    }
  }
  
  /// Sign out
  Future<void> signOut() async {
    try {
      await _auth.signOut();
      _userData = null;
      notifyListeners();
    } catch (e) {
      debugPrint('Error signing out: $e');
    }
  }
  
  /// Reset password
  Future<bool> resetPassword(String email) async {
    try {
      _error = null;
      await _auth.sendPasswordResetEmail(email: email.trim());
      return true;
    } on FirebaseAuthException catch (e) {
      _error = _getAuthErrorMessage(e.code);
      notifyListeners();
      return false;
    } catch (e) {
      _error = 'An unexpected error occurred. Please try again.';
      notifyListeners();
      return false;
    }
  }
  
  /// Update user profile
  Future<bool> updateProfile({
    String? name,
    String? phone,
    String? address,
  }) async {
    if (_user == null) return false;
    
    try {
      final updates = <String, dynamic>{
        'updatedAt': FieldValue.serverTimestamp(),
      };
      
      if (name != null) updates['name'] = name.trim();
      if (phone != null) updates['phone'] = phone.trim();
      if (address != null) updates['address'] = address.trim();
      
      await _firestore.collection('users').doc(_user!.uid).update(updates);
      await _loadUserData();
      notifyListeners();
      return true;
    } catch (e) {
      debugPrint('Error updating profile: $e');
      return false;
    }
  }
  
  /// Clear error
  void clearError() {
    _error = null;
    notifyListeners();
  }
  
  /// Get human-readable auth error message
  String _getAuthErrorMessage(String code) {
    switch (code) {
      case 'user-not-found':
        return 'No account found with this email.';
      case 'wrong-password':
        return 'Incorrect password. Please try again.';
      case 'email-already-in-use':
        return 'An account already exists with this email.';
      case 'invalid-email':
        return 'Please enter a valid email address.';
      case 'weak-password':
        return 'Password must be at least 6 characters.';
      case 'too-many-requests':
        return 'Too many attempts. Please try again later.';
      case 'network-request-failed':
        return 'Network error. Please check your connection.';
      default:
        return 'An error occurred. Please try again.';
    }
  }
}
