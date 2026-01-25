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
  String? _error;
  
  // Getters
  User? get user => _user;
  Map<String, dynamic>? get userData => _userData;
  bool get isLoading => _isLoading;
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
        // Generate referral code
        final newReferralCode = _generateReferralCode(credential.user!.uid);
        
        // Create user document
        await _firestore.collection('users').doc(credential.user!.uid).set({
          'email': email.trim(),
          'name': name.trim(),
          'phone': phone?.trim(),
          'referralCode': newReferralCode,
          'sponsorCode': referralCode?.trim(),
          'createdAt': FieldValue.serverTimestamp(),
          'isAdmin': false,
          'mlmEnabled': true,
        });
        
        // Save to public referral_codes collection
        await _firestore.collection('referral_codes').doc(newReferralCode).set({
          'userId': credential.user!.uid,
          'userName': name.trim(),
          'isActive': true,
          'createdAt': FieldValue.serverTimestamp(),
        });
        
        await _loadUserData();
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
  
  /// Generate unique referral code
  String _generateReferralCode(String uid) {
    final prefix = 'AFP';
    final first3 = uid.substring(0, 3).toUpperCase();
    final last3 = uid.substring(uid.length - 3).toUpperCase();
    return '$prefix$first3$last3';
  }
  
  /// Validate referral code
  Future<Map<String, dynamic>?> validateReferralCode(String code) async {
    try {
      final doc = await _firestore.collection('referral_codes').doc(code.toUpperCase()).get();
      if (doc.exists && doc.data()?['isActive'] == true) {
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
